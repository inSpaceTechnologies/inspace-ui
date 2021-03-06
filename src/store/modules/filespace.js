/*
Copyright (c) 2018 inSpace Technologies Ltd
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/
import axios from 'axios';
import logger from '../../logger';

const CONTRACT_ACCOUNT = 'filespace';

async function getAccountList(/* rpc */) {
  // TODO: get_table_by_scope has not been added to eosjs yet
  /*
  const result = await rpc.get_table_by_scope({
    json: true,
    code: CONTRACT_ACCOUNT,
    table: 'folders',
  });
  */
  const url = `${process.env.EOS_PROTOCOL}://${process.env.EOS_HOST}:${process.env.EOS_PORT}/v1/chain/get_table_by_scope`;
  const response = await axios.post(url, {
    json: true,
    code: CONTRACT_ACCOUNT,
    table: 'folders',
  });
  if (response.data.rows) {
    return response.data.rows.map(row => ({ accountName: row.scope }));
  }
  return [];
}

async function getTable(rpc, scope, tableName) {
  const result = await rpc.get_table_rows({
    json: true,
    scope,
    code: CONTRACT_ACCOUNT,
    table: tableName,
    limit: 500,
  });
  return result.rows;
}

async function getTables(rpc, accountName) {
  const data = {};
  data.rawFolders = await getTable(rpc, accountName, 'folders');
  data.rawFiles = await getTable(rpc, accountName, 'files');
  data.rawVersions = await getTable(rpc, accountName, 'versions');
  data.rawLikes = await getTable(rpc, CONTRACT_ACCOUNT, 'likes');
  data.rawKeys = await getTable(rpc, accountName, 'keys');
  data.rawEncKeys = await getTable(rpc, accountName, 'enckeys');
  return data;
}

async function getFilespaceData(rpc, accountName, ownPublicKey) {
  const {
    rawVersions,
    rawFiles,
    rawFolders,
    rawLikes,
    rawKeys,
    rawEncKeys,
  } = await getTables(rpc, accountName);

  // index the data
  const indexedVersions = {};
  const indexedFiles = {};
  const indexedFolders = {};
  const indexedKeys = {};

  rawVersions.forEach((version) => {
    version.likes = [];
    indexedVersions[version.id] = version;
  });
  rawFiles.forEach((file) => {
    indexedFiles[file.id] = file;
  });
  rawFolders.forEach((folder) => {
    indexedFolders[folder.id] = folder;
    folder.childFolders = [];
    folder.childFiles = [];
  });
  rawKeys.forEach((key) => {
    indexedKeys[key.id] = key;
  });

  // collapse the data
  let rootFolder = null;

  rawVersions.forEach((version) => {
    const file = indexedFiles[version.file];
    if (!file.versions) {
      file.versions = [];
    }
    file.versions.push(version);
  });

  rawFiles.forEach((file) => {
    if (file.current_version) {
      file.currentVersion = indexedVersions[file.current_version];
      if (!file.currentVersion) {
        logger.error(`File ${file.id} has missing current version ${file.current_version}.`);
      } else {
        const parentFolder = indexedFolders[file.parent_folder];
        parentFolder.childFiles.push(file);

        if (file.currentVersion.key) {
          rawEncKeys.forEach((rawEncKey) => {
            if (rawEncKey.key === file.currentVersion.key && rawEncKey.public_key === ownPublicKey) {
              file.currentVersion.encKey = rawEncKey;
            }
          });
          file.currentVersion.key = indexedKeys[file.currentVersion.key];
        }
      }
    }
  });

  rawFolders.forEach((folder) => {
    if (folder.parent_folder) {
      const parentFolder = indexedFolders[folder.parent_folder];
      parentFolder.childFolders.push(folder);
    } else {
      // no parent
      rootFolder = folder;
    }
  });

  rawLikes.forEach((like) => {
    if (like.liked === accountName) {
      const version = indexedVersions[like.version];
      if (!version) {
        // maybe it has been deleted
        return;
      }
      version.likes.push(like.liker);
    }
  });

  return (rootFolder);
}

async function getKeyData(keyID, rpc, accountName, ownPublicKey) {
  const rawKeys = await getTable(rpc, accountName, 'keys');
  const rawEncKeys = await getTable(rpc, accountName, 'enckeys');

  const indexedKeys = {};
  rawKeys.forEach((key) => {
    indexedKeys[key.id] = key;
  });

  let encKey;
  rawEncKeys.forEach((rawEncKey) => {
    if (rawEncKey.key === keyID && rawEncKey.public_key === ownPublicKey) {
      encKey = rawEncKey;
    }
  });
  return { encKey, key: indexedKeys[keyID] };
}

const storeState = {
  root: null,
};

const storeMutations = {
  setRoot(state, root) {
    state.root = root;
  },
};

const storeActions = {
  async addFolder({ rootState, rootGetters }, { id, name, parent }) {
    let parentId = 0;
    if (parent) {
      parentId = parent.id;
    }
    const { accountName } = rootGetters;
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'addfolder',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id,
          name,
          parent_folder: parentId,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    const newFolder = {
      id,
      name,
      childFiles: [],
      childFolders: [],
      parentId,
    };
    if (parent) {
      parent.childFolders.push(newFolder);
    }
    return newFolder;
  },
  async addFile({ rootState, rootGetters }, {
    id,
    name,
    date,
    ipfsHash,
    sha256,
    parent,
    keyIV,
    encryptedKey,
    publicKey,
    encryptedKeyIV,
    nonce,
  }) {
    const { accountName } = rootGetters;
    let keyID = 0;

    const version = {
      id,
      date,
      ipfs_hash: ipfsHash,
      sha256,
      likes: [],
    };

    if (keyIV) {
      keyID = id;
      await rootState.scatter.api.transact({
        actions: [{
          account: CONTRACT_ACCOUNT,
          name: 'addkey',
          authorization: [{
            actor: accountName,
            permission: 'active',
          }],
          data: {
            user: accountName,
            id: keyID,
            iv: keyIV,
          },
        }],
      }, {
        blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
        expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
      });

      version.key = {
        id: keyID,
        iv: keyIV,
      };
    }
    if (encryptedKey) {
      await rootState.scatter.api.transact({
        actions: [{
          account: CONTRACT_ACCOUNT,
          name: 'addenckey',
          authorization: [{
            actor: accountName,
            permission: 'active',
          }],
          data: {
            user: accountName,
            id,
            key: keyID,
            public_key: publicKey,
            iv: encryptedKeyIV,
            nonce,
            value: encryptedKey,
          },
        }],
      }, {
        blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
        expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
      });

      version.encKey = {
        id,
        key: keyID,
        public_key: publicKey,
        iv: encryptedKeyIV,
        nonce,
        value: encryptedKey,
      };
    }
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'addfile',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id,
          name,
          parent_folder: parent.id,
          current_version: 0,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'addversion',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id,
          ipfs_hash: ipfsHash,
          sha256,
          date,
          file: id,
          key: keyID,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'setcurrentve',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id,
          new_current_version: id,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    const newFile = {
      name,
      id,
      versions: [version],
      currentVersion: version,
    };
    parent.childFiles.push(newFile);
    return newFile;
  },
  async deleteFolder({ rootState, rootGetters }, {
    object,
    parent,
  }) {
    const { accountName } = rootGetters;
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'deletefolder',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id: object.id,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    if (parent) {
      const index = parent.childFolders.indexOf(object);
      parent.childFolders.splice(index, 1);
    }
  },
  async deleteFile({ rootState, rootGetters }, {
    object,
    parent,
  }) {
    const { accountName } = rootGetters;
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'deletefile',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id: object.id,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    if (parent) {
      const index = parent.childFiles.indexOf(object);
      parent.childFiles.splice(index, 1);
    }
  },
  async likeVersion({ rootState, rootGetters }, {
    version,
    accountName,
  }) {
    const myAccountName = rootGetters.accountName;
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'addlike',
        authorization: [{
          actor: myAccountName,
          permission: 'active',
        }],
        data: {
          user: myAccountName,
          id: Date.now(),
          liked: accountName || myAccountName,
          version: version.id,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
    version.likes.push(myAccountName);
  },
  async addPost({ rootState, rootGetters }, {
    id,
    isFolder,
    subject,
    caption,
  }) {
    const myAccountName = rootGetters.accountName;
    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'addpost',
        authorization: [{
          actor: myAccountName,
          permission: 'active',
        }],
        data: {
          account: myAccountName,
          id,
          is_folder: isFolder,
          subject: subject.id,
          caption,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
  },
  async getFilespace({
    dispatch,
    commit,
    rootState,
    rootGetters,
  }) {
    const { accountName, publicKey } = rootGetters;
    const rootFolder = await getFilespaceData(rootState.scatter.rpc, accountName, publicKey);
    if (rootFolder) {
      commit('setRoot', rootFolder);
      return;
    }
    // need to create the root
    dispatch('addFolder', { id: 1, name: process.env.FILESPACE_ROOT_NAME, parent: null }).then((newRoot) => {
      commit('setRoot', newRoot);
    });
  },
  // gets another user's filespace
  async getOtherFilespace({ rootState, rootGetters }, { accountName }) {
    const { publicKey } = rootGetters;
    const root = await getFilespaceData(rootState.scatter.rpc, accountName, publicKey);
    return root;
  },
  async getAccountList({ rootState }) {
    const accountList = await getAccountList(rootState.scatter.rpc);
    return accountList;
  },
  async getActivePublicKey({ rootState }, { accountName }) {
    const result = await rootState.scatter.rpc.get_account(accountName);
    const { permissions } = result;
    let key;
    permissions.forEach((permission) => {
      if (permission.perm_name === 'active') {
        const k = permission.required_auth.keys[0].key;
        key = k;
      }
    });
    return key;
  },
  async shareKey({ rootState, rootGetters }, {
    id,
    keyID,
    publicKey,
    encryptedKeyIV,
    nonce,
    encryptedKey,
  }) {
    const { accountName } = rootGetters;

    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'addenckey',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          id,
          key: keyID,
          public_key: publicKey,
          iv: encryptedKeyIV,
          nonce,
          value: encryptedKey,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });
  },
  async setProfile({ rootState, rootGetters }, {
    ipfsHash,
    keyIV,
    encryptedKey,
    publicKey,
    encryptedKeyIV,
    nonce,
  }) {
    let key = {};
    let encKey = {};

    const { accountName } = rootGetters;
    const id = Date.now();
    let keyID = 0;

    if (keyIV) {
      keyID = id;
      await rootState.scatter.api.transact({
        actions: [{
          account: CONTRACT_ACCOUNT,
          name: 'addkey',
          authorization: [{
            actor: accountName,
            permission: 'active',
          }],
          data: {
            user: accountName,
            id: keyID,
            iv: keyIV,
          },
        }],
      }, {
        blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
        expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
      });

      key = {
        id: keyID,
        iv: keyIV,
      };
    }
    if (encryptedKey) {
      await rootState.scatter.api.transact({
        actions: [{
          account: CONTRACT_ACCOUNT,
          name: 'addenckey',
          authorization: [{
            actor: accountName,
            permission: 'active',
          }],
          data: {
            user: accountName,
            id,
            key: keyID,
            public_key: publicKey,
            iv: encryptedKeyIV,
            nonce,
            value: encryptedKey,
          },
        }],
      }, {
        blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
        expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
      });

      encKey = {
        id,
        key: keyID,
        public_key: publicKey,
        iv: encryptedKeyIV,
        nonce,
        value: encryptedKey,
      };
    }

    await rootState.scatter.api.transact({
      actions: [{
        account: CONTRACT_ACCOUNT,
        name: 'setprofile',
        authorization: [{
          actor: accountName,
          permission: 'active',
        }],
        data: {
          user: accountName,
          ipfs_hash: ipfsHash,
          key: keyID,
        },
      }],
    }, {
      blocksBehind: parseInt(process.env.BLOCKS_BEHIND, 10),
      expireSeconds: parseInt(process.env.EXPIRE_SECONDS, 10),
    });

    return { key, encKey };
  },
  async getProfile({ rootState }, { accountName, ownPublicKey }) {
    const data = await getTable(rootState.scatter.rpc, accountName, 'profiles');
    if (data.length > 0) {
      const profile = data[0];
      if (profile.key) {
        // get the key
        const { encKey, key } = await getKeyData(profile.key, rootState.scatter.rpc, accountName, ownPublicKey);
        profile.encKey = encKey;
        profile.key = key;
      }
      return profile;
    }
    return null;
  },
  async getPosts({ rootState }) {
    const data = await getTable(rootState.scatter.rpc, CONTRACT_ACCOUNT, 'posts');
    return data;
  },
};

const storeGetters = {
  containsHash: state => (hash) => {
    function search(folder) {
      // check child files
      let found = false;
      folder.childFiles.forEach((childFile) => {
        childFile.versions.forEach((version) => {
          if (version.ipfs_hash === hash) {
            found = true;
          }
        });
      });
      if (found) {
        return true;
      }
      // check child folders
      folder.childFolders.forEach((childFolder) => {
        if (search(childFolder)) {
          found = true;
        }
      });
      return found;
    }
    return search(state.root);
  },
};

export default {
  state: storeState,
  actions: storeActions,
  mutations: storeMutations,
  getters: storeGetters,
};

/*
Copyright (c) 2018 inSpace Technologies Ltd
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/
import axios from 'axios';
import auth from './auth';

let axiosInstance = axios.create({ baseURL: process.env.API_SERVER_HOST });

async function getAxiosInstance() {
  // fetch every time in case expired
  const authData = await auth.getAuthData();

  // INTERIM: workaround for https://github.com/axios/axios/issues/385
  // save the default headers before changing any instances
  const defaultHeaders = JSON.parse(JSON.stringify(axios.defaults.headers));

  axiosInstance.defaults.headers.common['public-key'] = authData.publicKey;
  axiosInstance.defaults.headers.common.signature = authData.signature;
  axiosInstance.defaults.headers.common['expiration-date'] = authData.expirationDate;

  // re-set the default settings in the global axios
  axios.defaults.headers = defaultHeaders;

  return axiosInstance;
}

export default {
  init() {
    axiosInstance = axios.create({
      baseURL: process.env.API_SERVER_HOST,
    });
  },
  getAxiosInstance,
};

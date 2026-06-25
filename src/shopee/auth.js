'use strict';

const crypto = require('crypto');

/**
 * Gera a assinatura HMAC-SHA256 para Shopee Open API.
 * Formato: app_id + timestamp + path + access_token
 */
function signRequest({ appId, appSecret, accessToken, path, timestamp }) {
  const base = `${appId}${timestamp}${path}${accessToken}`;
  const sign = crypto
    .createHmac('sha256', appSecret)
    .update(base)
    .digest('hex');
  return sign;
}

/**
 * Retorna os query params de autenticação prontos para usar.
 */
function buildAuthParams({ appId, appSecret, accessToken, path }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signRequest({ appId, appSecret, accessToken, path, timestamp });
  return { app_id: appId, timestamp, sign, access_token: accessToken };
}

module.exports = { signRequest, buildAuthParams };

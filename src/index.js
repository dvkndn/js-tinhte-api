import React from 'react'
import randomBytes from 'randombytes'
import unfetch from 'isomorphic-unfetch'

import Callback from './components/Callback'
import hoc from './hoc'

require('es6-promise').polyfill()

export default (config = {}) => {
  if (typeof config !== 'object') {
    config = {}
  }
  const apiRoot = (typeof config.apiRoot === 'string') ? config.apiRoot : 'https://tinhte.vn/appforo/index.php'
  const callbackUrl = (typeof config.callbackUrl === 'string') ? config.callbackUrl : ''
  const clientId = (typeof config.clientId === 'string') ? config.clientId : ''
  const debug = (typeof config.debug === 'boolean') ? config.debug : false
  const delayMs = (typeof config.delayMs === 'number') ? config.delayMs : 10
  const scope = (typeof config.scope === 'string') ? config.scope : 'read'

  let auth = null
  if (typeof config.auth === 'object') {
    const ca = config.auth
    auth = {
      access_token: (typeof ca.access_token === 'string') ? ca.access_token : '',
      user_id: (typeof ca.user_id === 'number') ? ca.user_id : 0
    }
  }

  const authCallbacks = []
  let batchRequests = null
  let fetchCount = 0
  let requestLatestId = 0
  let secret = null

  const buildUrl = (url) => {
    if (url.match(/^https?:\/\//)) {
      return url
    }

    let urlQuery = url.replace('?', '&')
    if (auth && auth.access_token) {
      urlQuery += `&oauth_token=${auth.access_token}`
    }

    const finalUrl = `${apiRoot}?${urlQuery}`

    return finalUrl
  }

  const fetchJson = (url, options) => {
    fetchCount++

    const finalUrl = buildUrl(url)

    return unfetch(finalUrl, options)
      .then(response => response.json())
      .then((json) => {
        if (json.errors) {
          throw new Error(json.errors)
        }

        return json
      })
  }

  const internalApi = {
    buildAuthorizeUrl: () => {
      if (!clientId) {
        return null
      }

      if (secret === null) {
        secret = randomBytes(32).toString('hex')
      }

      const authorizeUrl = `${apiRoot}?oauth/authorize&` +
        `client_id=${clientId}&` +
        `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
        'response_type=token&' +
        `scope=${encodeURIComponent(scope)}&` +
        `state=${secret}`

      return authorizeUrl
    },

    getDelayMs: () => delayMs,

    isDebug: () => debug,

    setAuth: (newAuth) => {
      auth = {}

      const notifyWaitingForAuths = () => {
        api.fetchMultiple(() => {
          for (let callback of authCallbacks) {
            callback()
          }
        })
      }

      if (!newAuth || !newAuth.access_token || !newAuth.state) {
        return notifyWaitingForAuths()
      }

      if (newAuth.state !== secret) {
        return notifyWaitingForAuths()
      }

      auth = newAuth
      return notifyWaitingForAuths()
    }
  }

  const api = {
    CallbackComponent: () => <Callback internalApi={internalApi} />,

    getFetchCount: () => fetchCount,

    getUserId: () => (auth && auth.user_id) ? auth.user_id : 0,

    hocApiConsumer: hoc.ApiConsumer,

    hocApiProvider: (Component) => hoc.ApiProvider(api, internalApi, Component),

    fetchOne: (uri, method = 'GET', headers = {}, body = null) => {
      if (!uri) {
        return Promise.reject(new Error('uri is required'))
      }

      requestLatestId++

      const options = {
        uri,
        method,
        headers,
        body
      }

      if (batchRequests === null || body !== null) {
        return fetchJson(uri, options)
      } else {
        // a batch is pending, join it
        return new Promise((resolve, reject) => {
          batchRequests.push({
            options,
            id: '_req' + requestLatestId,
            resolve,
            reject
          })
        })
      }
    },

    fetchMultiple: (fetches) => {
      // initialize batchRequests as we are having a pending batch
      batchRequests = []
      fetches()

      const headers = {}
      const handlers = {}
      const batchBody = []
      const reqIds = {}
      for (let req of batchRequests) {
        for (let headerKey of Object.keys(req.options.headers)) {
          headers[headerKey] = req.options.headers[headerKey]
        }

        const id = req.id
        const uri = req.options.uri
        const method = req.options.method.toUpperCase()

        handlers[id] = {
          resolve: req.resolve,
          reject: req.reject
        }

        const reqUniqueKey = uri + method
        if (typeof reqIds[reqUniqueKey] === 'undefined') {
          reqIds[reqUniqueKey] = [id]
          batchBody.push({ id, uri, method })
        } else {
          reqIds[reqUniqueKey].push(id)
        }
      }

      // reset batchRequests to handle future requests normally
      batchRequests = null

      if (batchBody.length === 0) {
        return batchBody.length
      }

      fetchJson('/batch', {
        method: 'POST',
        body: JSON.stringify(batchBody)
      }).then(responses => {
        const handle = (jobId, reqId) => {
          if (typeof handlers[reqId] === 'undefined') {
            return
          }

          const { resolve, reject } = handlers[reqId]

          if (typeof responses.jobs[jobId] === 'object') {
            const json = responses.jobs[jobId]
            if (typeof json._job_result === 'string') {
              if (json._job_result === 'ok') {
                return resolve(json)
              } else if (json._job_error) {
                return reject(json._job_error)
              }
            }
          }

          return reject()
        }

        for (let reqUniqueKey of Object.keys(reqIds)) {
          const jobId = reqIds[reqUniqueKey][0]
          for (let reqId of reqIds[reqUniqueKey]) {
            handle(jobId, reqId)
          }
        }
      })

      return batchBody.length
    },

    onAuthenticated: (callback) => {
      if (typeof callback !== 'function') {
        return
      }

      if (auth !== null) {
        return callback()
      }

      return authCallbacks.push(callback)
    }
  }

  return api
}

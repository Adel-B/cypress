import _ from 'lodash'

import {
  Route,
  Request,
  CyHttpMessages,
  StaticResponse,
  SERIALIZABLE_REQ_PROPS,
  NetEventFrames,
} from '../types'
import {
  validateStaticResponse,
  getBackendStaticResponse,
  parseStaticResponseShorthand,
} from '../static-response-utils'
import $errUtils from '../../../cypress/error_utils'
import { HandlerFn } from './'
import Bluebird from 'bluebird'

export const onRequestReceived: HandlerFn<NetEventFrames.HttpRequestReceived> = (Cypress, frame, { getRoute, emitNetEvent }) => {
  function getRequestLog (route: Route, request: Omit<Request, 'log'>) {
    return Cypress.log({
      name: 'xhr',
      displayName: 'req',
      alias: route.alias,
      aliasType: 'route',
      type: 'parent',
      event: true,
      consoleProps: () => {
        return {
          Alias: route.alias,
          Method: request.request.method,
          URL: request.request.url,
          Matched: route.options,
          Handler: route.handler,
        }
      },
      renderProps: () => {
        return {
          indicator: request.state === 'Complete' ? 'successful' : 'pending',
          message: `${request.request.url} ${request.state}`,
        }
      },
    })
  }

  const route = getRoute(frame.routeHandlerId)
  const { req, requestId, routeHandlerId } = frame

  const sendContinueFrame = () => {
    if (continueSent) {
      throw new Error('sendContinueFrame called twice in handler')
    }

    continueSent = true

    if (request) {
      request.state = 'Intercepted'
    }

    if (continueFrame) {
      // copy changeable attributes of userReq to req in frame
      // @ts-ignore
      continueFrame.req = {
        ..._.pick(userReq, SERIALIZABLE_REQ_PROPS),
      }

      _.merge(request.request, continueFrame.req)

      emitNetEvent('http:request:continue', continueFrame)
    }
  }

  if (!route) {
    return sendContinueFrame()
  }

  const request: Partial<Request> = {
    id: requestId,
    request: req,
    state: 'Received',
  }

  request.log = getRequestLog(route, request as Omit<Request, 'log'>)
  request.log.snapshot('request')

  // TODO: this misnomer is a holdover from XHR, should be numRequests
  route.log.set('numResponses', (route.log.get('numResponses') || 0) + 1)
  route.requests[requestId] = request as Request

  if (frame.notificationOnly) {
    return
  }

  const continueFrame: Partial<NetEventFrames.HttpRequestContinue> = {
    routeHandlerId,
    requestId,
  }

  let resolved = false
  let replyCalled = false
  let continueSent = false

  route.hitCount++

  const userReq: CyHttpMessages.IncomingHttpRequest = {
    ...req,
    reply (responseHandler, maybeBody?, maybeHeaders?) {
      if (resolved) {
        return $errUtils.throwErrByPath('net_stubbing.request_handling.reply_called_after_resolved', { args: { route: route.options, req } })
      }

      if (replyCalled) {
        return $errUtils.throwErrByPath('net_stubbing.request_handling.multiple_reply_calls', { args: { route: route.options, req } })
      }

      replyCalled = true

      const staticResponse = parseStaticResponseShorthand(responseHandler, maybeBody, maybeHeaders)

      if (staticResponse) {
        responseHandler = staticResponse
      }

      if (_.isFunction(responseHandler)) {
        // allow `req` to be sent outgoing, then pass the response body to `responseHandler`
        request.responseHandler = responseHandler

        // signals server to send a http:response:received
        continueFrame.hasResponseHandler = true
        userReq.responseTimeout = userReq.responseTimeout || Cypress.config('responseTimeout')

        return sendContinueFrame()
      }

      if (!_.isUndefined(responseHandler)) {
        // `replyHandler` is a StaticResponse
        validateStaticResponse('req.reply', responseHandler)

        continueFrame.staticResponse = getBackendStaticResponse(responseHandler as StaticResponse)
      }

      return sendContinueFrame()
    },
    redirect (location, statusCode = 302) {
      userReq.reply({
        headers: { location },
        statusCode,
      })
    },
    destroy () {
      userReq.reply({
        forceNetworkError: true,
      })
    },
  }

  if (!_.isFunction(route.handler)) {
    return sendContinueFrame()
  }

  const handler = route.handler as Function

  const timeout = Cypress.config('defaultCommandTimeout')

  // if a Promise is returned, wait for it to resolve. if req.reply()
  // has not been called, continue to the next interceptor
  return Bluebird.try(() => {
    return handler(userReq)
  })
  .catch((err) => {
    $errUtils.throwErrByPath('net_stubbing.request_handling.cb_failed', {
      args: {
        err,
        req,
        route: route.options,
      },
      errProps: {
        appendToStack: {
          title: 'From request callback',
          content: err.stack,
        },
      },
    })
  })
  .timeout(timeout)
  .catch(Bluebird.TimeoutError, (err) => {
    $errUtils.throwErrByPath('net_stubbing.request_handling.cb_timeout', { args: { timeout, req, route: route.options } })
  })
  .finally(() => {
    resolved = true
  })
  .then(() => {
    if (!replyCalled) {
      // handler function resolved without resolving request, pass on
      continueFrame.tryNextRoute = true
      sendContinueFrame()
    }
  })
}

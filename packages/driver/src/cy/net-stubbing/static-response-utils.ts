import _ from 'lodash'

import {
  StaticResponse,
  BackendStaticResponse,
  FixtureOpts,
  ThrottleKbpsPreset,
} from '@packages/net-stubbing/lib/types'

// based off of https://source.chromium.org/chromium/chromium/src/+/master:chrome/test/chromedriver/chrome/network_list.cc
const NETWORK_THROTTLE_PRESETS: { [preset: string]: number } = {
  'gprs': 50,
  'edge': 250,
  '2g+': 450,
  '3g': 750,
  '3g+': 1536,
  '4g': 4096,
  'dsl': 2048,
  'wifi': 30720,
}

const getNetworkThrottlePreset = (preset: ThrottleKbpsPreset) => NETWORK_THROTTLE_PRESETS[preset]

// user-facing StaticResponse only
export const STATIC_RESPONSE_KEYS: (keyof StaticResponse)[] = ['body', 'fixture', 'statusCode', 'headers', 'forceNetworkError', 'throttleKbps', 'delayMs']

export function validateStaticResponse (staticResponse: StaticResponse): void {
  const { body, fixture, statusCode, headers, forceNetworkError, throttleKbps, delayMs } = staticResponse

  if (forceNetworkError && (body || statusCode || headers)) {
    throw new Error('`forceNetworkError`, if passed, must be the only option in the StaticResponse.')
  }

  if (body && fixture) {
    throw new Error('`body` and `fixture` cannot both be set, pick one.')
  }

  if (fixture && !_.isString(fixture)) {
    throw new Error('`fixture` must be a string containing a path and, optionally, an encoding separated by a comma (for example, "foo.txt,ascii").')
  }

  // statusCode must be a three-digit integer
  // @see https://tools.ietf.org/html/rfc2616#section-6.1.1
  if (statusCode && !(_.isNumber(statusCode) && _.inRange(statusCode, 100, 999))) {
    throw new Error('`statusCode` must be a number between 100 and 999 (inclusive).')
  }

  if (headers && _.keys(_.omitBy(headers, _.isString)).length) {
    throw new Error('`headers` must be a map of strings to strings.')
  }

  if (!_.isUndefined(throttleKbps)) {
    if (_.isNumber(throttleKbps) && (throttleKbps < 0 || !_.isFinite(throttleKbps))) {
      throw new Error('`throttleKbps` must be a finite, positive number.')
    } else if (_.isString(throttleKbps) && !getNetworkThrottlePreset(throttleKbps)) {
      throw new Error(`An invalid \`throttleKbps\` preset was passed. Valid presets are: ${_.keys(NETWORK_THROTTLE_PRESETS).join(', ')}`)
    } else if (!_.isString(throttleKbps) && !_.isNumber(throttleKbps)) {
      throw new Error('`throttleKbps` must be a finite, positive number or a string preset.')
    }
  }

  if (delayMs && (!_.isFinite(delayMs) || delayMs < 0)) {
    throw new Error('`delayMs` must be a finite, positive number.')
  }
}

export function parseStaticResponseShorthand (statusCodeOrBody: number | string | any, bodyOrHeaders: string | { [key: string]: string }, maybeHeaders?: { [key: string]: string }) {
  if (_.isNumber(statusCodeOrBody)) {
    // statusCodeOrBody is a status code
    const staticResponse: StaticResponse = {
      statusCode: statusCodeOrBody,
    }

    if (!_.isUndefined(bodyOrHeaders)) {
      staticResponse.body = bodyOrHeaders as string
    }

    if (_.isObject(maybeHeaders)) {
      staticResponse.headers = maybeHeaders as { [key: string]: string }
    }

    return staticResponse
  }

  if ((_.isString(statusCodeOrBody) || !hasStaticResponseKeys(statusCodeOrBody)) && !maybeHeaders) {
    const staticResponse: StaticResponse = {
      body: statusCodeOrBody,
    }

    if (_.isObject(bodyOrHeaders)) {
      staticResponse.headers = bodyOrHeaders as { [key: string]: string }
    }

    return staticResponse
  }

  return
}

function getFixtureOpts (fixture: string): FixtureOpts {
  const [filePath, encoding] = fixture.split(',')

  return { filePath, encoding }
}

export function getBackendStaticResponse (staticResponse: Readonly<StaticResponse>): BackendStaticResponse {
  const backendStaticResponse: BackendStaticResponse = _.omit(staticResponse, 'body', 'fixture', 'throttleKbps', 'delayMs')

  if (staticResponse.fixture) {
    backendStaticResponse.fixture = getFixtureOpts(staticResponse.fixture)
  }

  if (staticResponse.body) {
    if (_.isString(staticResponse.body)) {
      backendStaticResponse.body = staticResponse.body
    } else {
      backendStaticResponse.body = JSON.stringify(staticResponse.body)
      _.set(backendStaticResponse, 'headers.content-type', 'application/json')
    }
  }

  if (!_.isUndefined(staticResponse.throttleKbps)) {
    const kbps = staticResponse.throttleKbps

    backendStaticResponse.throttleKbps = _.isString(kbps) ? getNetworkThrottlePreset(kbps) : kbps
  }

  if (staticResponse.delayMs) {
    backendStaticResponse.continueResponseAt = Date.now() + staticResponse.delayMs
  }

  return backendStaticResponse
}

export function hasStaticResponseKeys (obj: any) {
  return _.intersection(_.keys(obj), STATIC_RESPONSE_KEYS).length || _.isEmpty(obj)
}

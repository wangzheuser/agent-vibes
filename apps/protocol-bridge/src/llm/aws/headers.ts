/**
 * Kiro request headers helpers.
 *
 * Reproduces the User-Agent / x-amz-user-agent shapes that the AWS SDK uses
 * when running inside Kiro IDE. Versions and `m/N` mode validated against
 * captured KiroIDE 0.12.200 traffic (scripts/capture/kiro_traffic.log).
 */

import * as os from "os"
import * as process from "process"

/** Streaming SDK version reported in User-Agent (抓包：1.0.39). */
const KIRO_STREAMING_SDK_VERSION = "1.0.39"
/** Runtime SDK version reported in User-Agent for REST calls. */
const KIRO_RUNTIME_SDK_VERSION = "1.0.0"

/** Default Kiro IDE version (抓包：0.12.200). */
const DEFAULT_KIRO_VERSION = "0.12.200"
/** Default Node.js version reported in User-Agent. */
const DEFAULT_NODE_VERSION = "22.22.0"

export interface KiroClientConfig {
  kiroVersion: string
  systemVersion: string
  nodeVersion: string
}

export interface KiroHeaderValues {
  userAgent: string
  amzUserAgent: string
  host: string
}

function defaultSystemVersion(): string {
  switch (process.platform) {
    case "win32": {
      const release = os.release() || "10.0.22631"
      return `win32#${release}`
    }
    case "darwin":
      return `darwin#${os.release() || "24.6.0"}`
    default:
      return `linux#${os.release() || "6.6.87"}`
  }
}

export function getKiroClientConfig(
  override?: Partial<KiroClientConfig>
): KiroClientConfig {
  return {
    kiroVersion: override?.kiroVersion?.trim() || DEFAULT_KIRO_VERSION,
    systemVersion: override?.systemVersion?.trim() || defaultSystemVersion(),
    nodeVersion: override?.nodeVersion?.trim() || DEFAULT_NODE_VERSION,
  }
}

export interface BuildKiroHeaderValuesOptions {
  machineId?: string
  host?: string
  client?: Partial<KiroClientConfig>
}

function buildKiroHeaderValues(
  apiName: string,
  sdkVersion: string,
  mode: string,
  options: BuildKiroHeaderValuesOptions = {}
): KiroHeaderValues {
  const cfg = getKiroClientConfig(options.client)
  const machineId = options.machineId?.trim() || ""

  let userAgent =
    `aws-sdk-js/${sdkVersion} ua/2.1 ` +
    `os/${cfg.systemVersion} lang/js md/nodejs#${cfg.nodeVersion} ` +
    `api/${apiName}#${sdkVersion} ${mode} ` +
    `KiroIDE-${cfg.kiroVersion}`
  let amzUserAgent = `aws-sdk-js/${sdkVersion} KiroIDE-${cfg.kiroVersion}`

  if (machineId) {
    userAgent += `-${machineId}`
    amzUserAgent += `-${machineId}`
  }

  return {
    userAgent,
    amzUserAgent,
    host: options.host?.trim() || "",
  }
}

export function buildStreamingHeaderValues(
  options: BuildKiroHeaderValuesOptions = {}
): KiroHeaderValues {
  // 抓包验证：streaming UA mode 是 "m/N"（不是 "m/E"）。
  return buildKiroHeaderValues(
    "codewhispererstreaming",
    KIRO_STREAMING_SDK_VERSION,
    "m/N",
    options
  )
}

export function buildRuntimeHeaderValues(
  options: BuildKiroHeaderValuesOptions = {}
): KiroHeaderValues {
  return buildKiroHeaderValues(
    "codewhispererruntime",
    KIRO_RUNTIME_SDK_VERSION,
    "m/N,E",
    options
  )
}

export interface KiroRequestHeaderInputs {
  accessToken?: string
  values: KiroHeaderValues
  /**
   * Additional headers to merge in (will be overridden by the base headers
   * when the keys collide).
   */
  extra?: Record<string, string>
}

export function buildKiroBaseHeaders(
  inputs: KiroRequestHeaderInputs
): Record<string, string> {
  // 抓包对齐的头大小写：UA / amz-* / host 用小写，
  // Authorization 首字母大写。`x-amzn-codewhisperer-optout`
  // 官方客户端不发，已移除。
  const headers: Record<string, string> = {
    ...inputs.extra,
    "user-agent": inputs.values.userAgent,
    "x-amz-user-agent": inputs.values.amzUserAgent,
  }
  if (inputs.accessToken) {
    headers["Authorization"] = `Bearer ${inputs.accessToken}`
  }
  if (inputs.values.host) {
    headers["host"] = inputs.values.host
  }
  return headers
}

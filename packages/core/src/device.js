'use strict';

/**
 * 设备身份（对应原项目 server.js 里的「平台标识 Cookie 注入中间件」）
 *
 * 酷狗服务端会按设备维度做风控，所以这套身份必须**在同一个安装上保持稳定**：
 * 每次启动都随机生成一套新身份，很容易被判定为异常设备（触发验证码 / 限流）。
 * 因此调用方应把它持久化，下次启动时传回来。
 *
 * 身份各项含义（沿用原项目的 cookie 命名，vendor 的模块会直接读这些 key）：
 *   KUGOU_API_GUID   设备全局唯一标识，md5(uuid v4)
 *   KUGOU_API_MID    由 GUID 推导的设备 MID（原项目 calculateMid 算法）
 *   KUGOU_API_DEV    开发设备标识，10 位大写字符串
 *   KUGOU_API_MAC    设备 MAC，固定值即可
 *   KUGOU_API_WEBGL  WebGL 指纹哈希，用于行为指纹（SID/EDT）生成
 *   dfid             设备指纹 ID，register_dev 成功后会返回真实值
 */

const { cryptoMd5 } = require('./kugou/vendor/util/crypto');
const { getGuid, calculateMid, generateWebGLHash, randomString } = require('./kugou/vendor/util/util');

const DEFAULT_MAC = '02:00:00:00:00:00';

/**
 * 生成一套全新的设备身份
 * @returns {Record<string, string>}
 */
function generateDeviceIdentity() {
  // 原项目: const guid = cryptoMd5(getGuid())
  const guid = cryptoMd5(getGuid());

  return {
    KUGOU_API_PLATFORM: '',
    KUGOU_API_GUID: guid,
    // 原项目: calculateMid(env_guid ?? guid)
    KUGOU_API_MID: calculateMid(guid),
    KUGOU_API_DEV: randomString(10).toUpperCase(),
    KUGOU_API_MAC: DEFAULT_MAC,
    KUGOU_API_WEBGL: generateWebGLHash(),
    // dfid 是设备指纹 ID，必须由酷狗通过 register_dev 下发才有效。
    // 凭空编一个随机值会被服务端判定为伪造，直接触发风控
    // （实测：随机 dfid 时 song_url 返回 errcode=20028「本次请求需要验证」，
    //   用 '-' 则正常返回播放地址）。
    // 上游 server.js 同样不注入 dfid，模块各自回落到 '-'。
    dfid: '-',
  };
}

/**
 * 校验/补全一份已持久化的设备身份
 *
 * - 缺少 GUID 视为无效，重新生成
 * - 老版本存档可能缺字段，用新生成的补齐
 * - MID 始终由 GUID 重算，避免存档里的两者不一致
 *
 * @param {Record<string, string>|null|undefined} saved
 * @returns {Record<string, string>}
 */
function normalizeDeviceIdentity(saved) {
  if (!saved || typeof saved !== 'object' || !saved.KUGOU_API_GUID) {
    return generateDeviceIdentity();
  }

  const merged = Object.assign(generateDeviceIdentity(), saved);
  // MID 是 GUID 的纯函数推导结果，以 GUID 为准重算
  merged.KUGOU_API_MID = calculateMid(merged.KUGOU_API_GUID);
  return merged;
}

module.exports = { generateDeviceIdentity, normalizeDeviceIdentity, DEFAULT_MAC };

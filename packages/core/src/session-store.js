'use strict';

/**
 * 会话持久化（Node 端实现）
 *
 * 核心只定义「存/取」这层抽象，具体存储介质由各端提供：
 *   - 桌面端(Electron)：用本文件的 FileSessionStore 落 JSON 文件
 *   - 手机端(React Native)：不能用 fs，改用 AsyncStorage 实现同样的 load/save
 *
 * 存两个东西：
 *   device  设备身份。**必须持久化**，每次启动都换新身份会被酷狗判为异常设备。
 *   session 登录态（token / userid / dfid）。丢掉就要重新扫码。
 */

const fs = require('node:fs');
const path = require('node:path');

class FileSessionStore {
  /**
   * @param {string} filePath 存档路径，如 <userData>/kugou-session.json
   */
  constructor(filePath) {
    this.filePath = filePath;
  }

  /** @returns {{device?: object, session?: object}} 读取失败时返回空对象 */
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // 首次运行没有存档，属于正常情况
      return {};
    }
  }

  /** @param {{device?: object, session?: object}} state */
  save(state) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8');
  }

  /** 退出登录：只清会话，保留设备身份（避免设备被当成新设备重新风控） */
  clearSession(state = {}) {
    this.save({ device: state.device, session: {} });
  }
}

/**
 * 内存实现，给测试和无持久化场景用
 */
class MemorySessionStore {
  constructor(initial = {}) {
    this.state = initial;
  }

  load() {
    return this.state;
  }

  save(state) {
    this.state = state;
  }

  clearSession(state = {}) {
    this.state = { device: state.device, session: {} };
  }
}

module.exports = { FileSessionStore, MemorySessionStore };

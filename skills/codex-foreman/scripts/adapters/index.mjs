// 静态注册表；配置和分派统一读取适配器的能力声明。
import codex from './codex-cli.mjs';
import opencode from './opencode-cli.mjs';
import pi from './pi-cli.mjs';
import api from './api.mjs';
import antigravity from './antigravity-cli.mjs';
import antigravityDesktop from './antigravity-desktop.mjs';

export const adapters = Object.fromEntries([codex, opencode, pi, antigravity, antigravityDesktop, api].map((adapter) => [adapter.type, adapter]));

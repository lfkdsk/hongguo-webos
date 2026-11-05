# 红果短剧 webOS TV

LG webOS TV 上的独立短剧应用实验版。项目借鉴 [dsh-hongguo](https://github.com/frostming/dsh-hongguo) 的功能设计，使用 [openhongguo](https://github.com/beilunyang/openhongguo) 获取目录与播放模型；电视端用随应用打包的 JavaScript Service 和 ffmpeg 处理媒体。当前优先验证个人设备上的安装与播放。

## 结构

- `app/`：电视遥控器可操作的目录、搜索、选集与播放器。
- `service/`：匿名设备 SDK、本地 HTTP 接口、封面转换、媒体缓存与 Range 播放。
- 页面通过 Luna `ping` 启动 Service，获得随机令牌和 `127.0.0.1` 端口。内容密钥仅保留在 Service 内。

## 构建

需要 Node.js 20、webOS TV CLI，以及 `service/ffmpeg` 中适用于目标电视的静态 ffmpeg。

```sh
npm run install:service
python3 scripts/make_icon.py
npm run build
ares-install -d YOUR_TV dist/com.lfkdsk.hongguo_0.1.0_all.ipk
ares-launch -d YOUR_TV com.lfkdsk.hongguo
```

已在 LG C5 的 webOS 开发者环境中验证静态 ffmpeg 可执行，并使用自制测试视频验证了 CENC AES-CTR 解密。实际剧集端到端播放仍需在本应用中测试。

桌面调试不需要电视。`service/ffmpeg` 是电视用的 ARM 版，本机要另外指定 ffmpeg：

```sh
HONGGUO_FFMPEG=ffmpeg npm run dev
```

打开输出的地址，窗口设为 1920×1080，方向键、回车和 Esc 对应遥控器。

## 遥控器

| 按键 | 浏览 | 播放器 |
| --- | --- | --- |
| 方向键 | 移动焦点 | ←→ 快退快进 10 秒，↑ 切换倍速，↓ 选集 |
| OK | 打开 | 暂停 / 继续 |
| 返回 | 回到上一层，顶部标签上退出应用 | 退出播放 |
| 播放键 | 刷新当前页 | 播放 / 暂停 |

## 已知限制

服务端从 2026-10-29 起基本只给每台匿名设备返回一次播放模型，详见 openhongguo 的“自动更换设备”一节。已缓存的分集不再请求播放模型。

## 第三方组件

- `openhongguo`：Apache 2.0。其文档声明仅供学习与研究；视频内容版权属于权利人。
- `app/vendor/webOSTV.js`：LG webOSTV.js 1.2.13，附带许可证。
- `service/ffmpeg`：FFmpeg 7.0.2 静态 ARM 版，来自 [John Van Sickle 的构建](https://johnvansickle.com/ffmpeg/)；运行 `service/ffmpeg -version` 可查看编译选项。FFmpeg 源代码与许可信息见 [FFmpeg 官方网站](https://ffmpeg.org/legal.html)。

这个仓库暂时保持私有，用于个人开发与实机验证。公开发布应用前须另行确认软件与视频内容的分发权限。

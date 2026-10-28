# Life Fitness · 居家健身产品 Demo

**在线展示：[打开 Demo](https://tiandee0801-stack.github.io/life-fitness-demo/)** · 支持电脑、平板与手机浏览器。

个人 AI 产品实践：把用户档案、一次动作观察、练后反馈和历史记录连接起来。界面参考 Good-GYM 手机端，采用黑底荧光绿、大视频、中央计数与四项导航。项目于2026年制作，尚无真实用户交付或效果数据。

## 在线版与本地版

| 能力 | GitHub Pages 在线展示 | 完整本地版 |
| --- | --- | --- |
| 电脑与手机界面 | 自适应布局 | 手机风格界面及原版网页 |
| 档案、反馈、历史、导出 | 当前浏览器保存；演示数据 | 本地 SQLite 保存 |
| Coach | 明确标记的预设流程讲解 | 本地 Qwen 模型回答及范围规则 |
| 视频与骨架 | 自选视频仅预览；原创动画演示预设计数 | YOLOX / RTMPose + 时间戳状态机 |
| 摄像头 | 无需摄像头，使用流程样例 | 用户主动授权录制，结束后分析 |

GitHub Pages 不运行 Python 后端。线上骨架、计数和讲解是**预设样例，不是 AI 推理结果**，不会把访客视频上传到服务器。浏览器记录不跨设备同步。模型与用户数据未上传仓库。

## 如何演示

1. 打开在线链接，在「目标」保存一份演示档案。
2. 「训练」右上角打开 Coach，查看预设流程讲解。
3. 点击「播放完整流程样例」，播放原创几何动画，查看同步骨架和计数。
4. 记录感受，再到「历史」按日期回看；「设置」可导出或清空此浏览器数据。
5. 导入自己的视频仅能预览。真实问答和识别请运行本地版。

## 本地版

`server.py` 是仅绑定 `127.0.0.1` 的单人服务；不应直接暴露到公网。Python 3.11+，另需 ffmpeg/ffprobe、rtmlib、onnxruntime、opencv-python、numpy；本地 Coach 当前使用 Apple Silicon 的 mlx-lm。模型需自行下载并核对上游许可证。

关键模型文件：
- YOLOX：`yolox_nano_8xb8-300e_humanart-40f6f0d0.onnx`
- RTMPose：`rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.onnx`
- Coach：`mlx-community/Qwen3-4B-Instruct-2507-4bit`

配置环境变量后运行（路径用自己的实际位置替换）：

```sh
export LF_POSE_MODELS=/path/to/pose-models
export LF_MODEL_PATH=/path/to/Qwen3-4B-Instruct-2507-4bit
export LF_MEDIA_TOOLS=/path/to/ffmpeg-bin
export LF_FFPROBE=/path/to/ffmpeg-bin/ffprobe
export LF_COACH_PYTHON=/path/to/coach-env/bin/python
export LF_VISION_PYTHON=/path/to/vision-env/bin/python
python3 server.py --port 8844
```

打开 `http://127.0.0.1:8844/mobile.html`。模型未配置时会明确报错，不伪造模型结果。当前首版仅观察弯举，录制后分析；Coach 不读取视频结果自动调整训练安排。计数不表示动作标准或训练有效性。

## 目录与检查

- `docs/`：公开响应式展示页面与原创动画素材，无后端依赖。
- `dist/`：本地完整服务的网页。
- `engine/`：Coach、姿态观察、周期计数。
- `data/knowledge.json`：带来源的公开资料卡。
- `tests/`：接口、规则、计数与媒体边界检查；依赖不全时部分测试会跳过。

```sh
python3 -m unittest discover -s tests
python3 -m http.server 8850 --bind 127.0.0.1 --directory docs
```

第二条命令仅预览 Pages 版本。项目未进行大规模真实视频准确率或用户效果评测。

## 来源

参考 [Good-GYM](https://github.com/yo-WASSUP/Good-GYM) 的手机界面及角度计数思路；网页为独立重建，非官方产品，未移植 iOS 源码。模型使用 [rtmlib](https://github.com/Tau-J/rtmlib) 与 [MMPose](https://github.com/open-mmlab/mmpose) 生态。版权与上游许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

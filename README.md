# IdeaAgent

在 IdeaAgent 网页回看录音、字幕和调研结果。原始录音留在本机。DeepSeek 读取整场逐字稿来制定计划，检索服务只接收整理后的公开查询。打开网页时显示最近一份结果，选中样本后可先试听该录音，再开始处理。

## 当前实现与模块来源

| 功能 | 已实现的行为 | 复用与自写部分 |
| --- | --- | --- |
| 本地转写 | 接收 WAV、MP3、M4A。生成逐字稿、起止时间和 `SPEAKER_00` 等说话人标签，保留原始 `audio.json`。 | 直接调用 **WhisperX 3.8.6 CLI**，转写、时间对齐和 pyannote 说话人区分由 WhisperX 完成。**FFmpeg** 转换音频。IdeaAgent 负责 Windows 运行适配和 JSON 字段转换。 |
| 跨文件说话人匹配和报告名单 | 报告生成后，在本机比较 WhisperX 声纹。网页可回听每个本场标签并确认或撤销身份。网页和 Markdown 下载件都标出本场已确认的可查看人员。 | 声纹、联系人和匹配结果保存在 `.idea-agent`。名单由本场的人工登记生成，同一个联系人只显示一次。 |
| 网页交互 | 使用音频播放器回听录音，查看时间线和字幕、展开卡片、定位主依据发言、点开网页来源。支持上传录音、运行本地会议样本、查看状态和下载 Markdown。 | 复用 **InsightToast React Demo** 的时间线、字幕、卡片、原话侧栏和引用组件。IdeaAgent 接入浏览器音频播放器，添加上传、样本选择、状态和下载入口，并把结果映射为 Demo 可读取的数据。 |
| 制定调研计划 | 一次 DeepSeek JSON 调用判断研究阶段，从整场转写提出值得查的问题。每项任务记录相关路线、触发发言和公开查询。同一检索类型下的重复查询只执行一次。没有成形科研构思时不检索。 | 提示词参照 [Omakase 附录 C.4–C.5](https://arxiv.org/html/2604.08898v1)。 |
| 执行检索 | 所有公开调研任务默认用 **DeepSeek Search**，包括论文相关问题。配置 **ScholarQA** 后，跨论文比较任务使用该服务。每项保存来源、证据和执行状态。 | IdeaAgent 负责调用和字段转换，网页复用 InsightToast 的引用展示。 |
| 生成报告 | 有证据时，用一次 DeepSeek 调用把检索结果整理成发现、路线影响、证据缺口和下一步验证。输出 `research.json`、`input.json` 和 `report.md`，并用同一份结果生成侧栏条目。 | 建议生成参照 Omakase 附录 C.6。FastAPI 提供上传、后台任务、状态和文件导出。 |

## Windows 启动

工作目录为 `D:\projects\IdeaAgent`。本地源码取自 InsightToast 提交 `d394ef86da8c20d569a4923fec08b56703488ee0` 和 WhisperX 标签 `v3.8.6`，分别位于 `InsightToast-demo` 和 `WhisperX`。

首次安装依赖，在项目根目录执行：

```powershell
$env:UV_CACHE_DIR = Join-Path (Get-Location) '.uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path (Get-Location) '.uv-python'
uv python install 3.11
uv venv --python 3.11
uv pip install --python .\.venv\Scripts\python.exe 'torch==2.8.0' 'torchaudio==2.8.0' 'torchvision==0.23.0' 'whisperx==3.8.6' 'pyannote-audio==4.0.0' 'torchcodec==0.7.0' 'fastapi==0.116.1' 'uvicorn==0.35.0' 'python-multipart' 'python-dotenv' 'requests'
.\.venv\Scripts\python.exe -m nltk.downloader -d .\.idea-agent\nltk-data punkt_tab
```

本机安装时从公开镜像下载了 PyTorch wheel，并与 PyPI 发布的 SHA-256 比对。若重建此环境并使用现有缓存，将安装命令中的 `'torch==2.8.0'` 替换为 `'.\.tools\wheels\torch-2.8.0-cp311-cp311-win_amd64.whl'`，并在 `uv pip install` 后加 `--offline`。

下载 FFmpeg 7.1.1 shared 版，将其解压到 `.tools`。在 Hugging Face 登录并接受 pyannote 模型的使用条款，在项目根目录的 `.env` 中配置有读取权限的 `HF_TOKEN` 和官方 `DEEPSEEK_API_KEY`。PowerShell 中已有的同名环境变量优先。修改凭据后重启处理服务。 [FFmpeg 下载](https://github.com/GyanD/codexffmpeg/releases/tag/7.1.1) · [pyannote 模型](https://huggingface.co/pyannote/speaker-diarization-community-1) · [DeepSeek API](https://platform.deepseek.com/)

日常使用时，双击 `Start-IdeaAgent.cmd`，或在项目根目录执行下面的命令。启动后打开 [IdeaAgent](http://127.0.0.1:4344/)，保留启动窗口。

```powershell
Set-Location D:\projects\IdeaAgent
.\Start-IdeaAgent.cmd
```

首次构建或修改前端后，运行下面的命令更新网页文件：

```powershell
Set-Location D:\projects\IdeaAgent\InsightToast-demo\frontend
npm.cmd ci --no-audit --no-fund
npm.cmd run build
```

在网页选择「会议样本」，点「运行样本」。也可以点「上传录音」，从项目下的 `meeting-samples` 选择录音，或上传自己的 WAV、MP3、M4A。处理完成后，用卡片上的引号按钮查看依据，点「下载 Markdown」保存简报。运行产物在 `.idea-agent`。

新录音处理完成后，展开「报告可查看人员（本地名单）」。点「回听」核对原话，再点「确认人员」，选择已有联系人或新建联系人。声纹匹配给出的候选需要点「确认并加入名单」才会显示在名单里。可以用「撤销确认」移除本场对应关系。下载 Markdown 时，会在标题下标注当时的名单，原始报告内容仍保存在 `report.md`。旧结果没有声纹时仍可回看和下载。「本地名单」供手动分享时核对，实际文档的访问权限由分享平台设置。

本机验收时已提前缓存 WhisperX 和 pyannote 权重，并在启动处理服务前设置 `$env:HF_HUB_OFFLINE = '1'`。这个设置只影响 Hugging Face 的模型加载，DeepSeek 调研仍联网。初次下载模型时使用默认的在线模式。

在项目根目录运行本机回归检查：

```powershell
.\.venv\Scripts\python.exe -m unittest -v test_idea_agent
```

已有 WhisperX 文件可用 `idea_agent.load_transcript(Path("已有目录/audio.json"))` 直接读入，再交给 `plan_research()` 检查计划。规划会调用真实 DeepSeek。加拿大样本是政策讨论，可用于检查无科研构思时的报告和录音回看。

## 可选：ScholarQA 学术检索增强

在独立 Linux 环境运行 [上游 ScholarQA API](https://github.com/allenai/ai2-scholarqa-lib#async-api)。服务端配置 `S2_API_KEY` 和 `DEEPSEEK_API_KEY`，并在上游 `run_config.pipeline_args` 中显式设置 `llm_model` 与 `decomposer_llm` 为已验证的 LiteLLM DeepSeek 模型。将 `fallback_llm` 显式设为 `null`，避免上游回退到其他供应商。首轮验证可将 `reranker_args` 设为 `null`，并将 `run_table_generation` 设为 `false`，只验证论文检索、引文和正文生成。上游 `validate` 调用 OpenAI 审核接口，DeepSeek-only 环境设为 `false`，将服务限制在本地或可信网络内。

先在 Linux 服务上用一个公开问题检查模型和引用输出。再在 Windows 项目 `.env` 设置完整接口地址，例如 `SCHOLARQA_URL=http://127.0.0.1:8000/query_corpusqa`，重启 IdeaAgent。地址留空时，所有任务都由 DeepSeek Search 执行，无需 Linux 服务或 `S2_API_KEY`。ScholarQA 客户端的提交、轮询和证据映射已用模拟响应测试，真实服务需单独验收。

## 加拿大会议样本

上游 Demo 附带一份加拿大会议录像。`meeting-samples` 收录从该录像提取的完整音轨和三段议题片段。默认 Demo 使用完整音轨。01 与此前端到端验收的录音文件一致。 [InsightToast 原始录像](https://github.com/ubixgroup/InsightToast/blob/d394ef86da8c20d569a4923fec08b56703488ee0/frontend/public/video.mp4)

| 文件 | 原录像范围 | 长度 |
| --- | --- | --- |
| 00 加拿大会议 - 完整录音.m4a | 完整音轨 | 5:07 |
| 01 加拿大会议 - 减排目标与工业碳定价.wav | 00:00–02:00 | 2:00 |
| 02 加拿大会议 - 联邦碳定价与魁北克.wav | 01:58–03:35 | 1:37 |
| 03 加拿大会议 - 加拿大与欧盟碳市场.wav | 03:39–05:06 | 1:27 |

## AMI 长会议样本

`meeting-samples` 另有 20 段 AMI 英语会议录音，可在 IdeaAgent 的「会议样本」下拉菜单中选择 `AMI` 开头的文件。原音频由 AMI Consortium 发布，来源为爱丁堡大学的 [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/)，许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。样本由原始混合耳麦音轨转为单声道 M4A，超过 20 分钟的场次取开头 20 分钟。

| 文件 | 时长 | 内容 | 原始音频 |
| --- | ---: | --- | --- |
| AMI ES2003a.m4a | 19:00 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2003a.Mix-Headset.wav) |
| AMI ES2004a.m4a | 17:29 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2004a.Mix-Headset.wav) |
| AMI ES2007a.m4a | 20:00 | 产品设计场景，截取前 20 分钟 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2007a.Mix-Headset.wav) |
| AMI ES2008a.m4a | 17:23 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2008a.Mix-Headset.wav) |
| AMI ES2010a.m4a | 10:44 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2010a.Mix-Headset.wav) |
| AMI ES2011a.m4a | 18:34 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2011a.Mix-Headset.wav) |
| AMI ES2012a.m4a | 18:25 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2012a.Mix-Headset.wav) |
| AMI ES2013a.m4a | 13:45 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2013a.Mix-Headset.wav) |
| AMI ES2014a.m4a | 19:09 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2014a.Mix-Headset.wav) |
| AMI ES2015a.m4a | 19:07 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2015a.Mix-Headset.wav) |
| AMI IN1009.m4a | 20:00 | 非场景会议，截取前 20 分钟 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IN1009.Mix-Headset.wav) |
| AMI IS1001a.m4a | 15:09 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1001a.Mix-Headset.wav) |
| AMI IS1003a.m4a | 15:13 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1003a.Mix-Headset.wav) |
| AMI IS1004a.m4a | 13:17 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1004a.Mix-Headset.wav) |
| AMI IS1005a.m4a | 17:05 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1005a.Mix-Headset.wav) |
| AMI IS1006a.m4a | 14:11 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1006a.Mix-Headset.wav) |
| AMI IS1007a.m4a | 16:06 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1007a.Mix-Headset.wav) |
| AMI IS1008a.m4a | 15:44 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1008a.Mix-Headset.wav) |
| AMI IS1009a.m4a | 13:59 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/IS1009a.Mix-Headset.wav) |
| AMI TS3010a.m4a | 17:21 | 产品设计场景 | [WAV](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/TS3010a.Mix-Headset.wav) |

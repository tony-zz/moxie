# 课文默写（PWA）

拍课文 → DeepSeek 识别要默写的内容 → 顺序/随机逐个朗读 → 说“好了”或点按钮报下一个。

纯静态网页，没有后端：手机直接调用 DeepSeek API（`deepseek-flash`，支持看图），API Key 只存在手机本地。

## 本机试用

```
cd D:\we\dictation-app
python -m http.server 8080
```

电脑浏览器打开 http://localhost:8080 。

## 发布到 GitHub Pages（免费）

1. 在 github.com 新建公开仓库，例如 `dictation`。
2. 上传本目录的全部文件（包括 `icons/`）。
3. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`，保存。
4. 一两分钟后访问 `https://<用户名>.github.io/dictation/`。

## 装到 iPhone

1. 用 **Safari** 打开上面的网址。
2. 点底部「分享」→「添加到主屏幕」。
3. 从桌面图标打开 → 右上角 ⚙︎ → 填 DeepSeek API Key → 保存。

## 更新

改完文件后，把 `sw.js` 里的 `VERSION` 加 1（如 `v2`）再上传。手机上打开两次 App 就是新版。

## 注意

- 仓库是公开的，**不要把 API Key 写进任何文件**。
- 建议 DeepSeek 账户只充少量余额；手机丢了就在 platform.deepseek.com 删除该 Key。

# web/vendor

설치할 때 npm 이 필요 없도록 브라우저 라이브러리의 빌드된 파일과 글꼴을 그대로 둔다. `npm run vendor` 가 `node_modules` 에서 자바스크립트 다섯을 다시 만든다(`rough.js` 는 mermaid 가 쓰는 roughjs 를 그대로 옮긴다). Pretendard 는 패키지가 커서(약 100MB) 개발 의존성에 넣지 않고 `npm pack pretendard@1.3.9` 로 받은 묶음에서 옮겼다. 판서 손글씨는 google/fonts 저장소의 `ofl/nanumpenscript/NanumPenScript-Regular.ttf` 를 fonttools 로 글리프·이름 표를 그대로 둔 채 woff2 로만 바꿨다(`python3 -m fontTools.ttLib.woff2 compress -o NanumPenScript.woff2 NanumPenScript-Regular.ttf`).

| 파일 | 출처 | 판 | 라이선스 |
|---|---|---|---|
| `elk.js` | `elkjs/lib/elk.bundled.js` | 0.12.0 | EPL-2.0 (`elk.LICENSE.md`) |
| `mermaid.js` | `mermaid/dist/mermaid.min.js` | 12.1.0 | MIT (`mermaid.LICENSE`) |
| `markdown-it.js` | `markdown-it/dist/browser/markdown-it.umd.min.js` | 15.0.3 | MIT (`markdown-it.LICENSE`) |
| `purify.js` | `dompurify/dist/purify.min.js` | 3.4.17 | MPL-2.0 또는 Apache-2.0 (`purify.LICENSE`) |
| `PretendardVariable.woff2` | `pretendard/dist/web/variable/woff2/PretendardVariable.woff2` | 1.3.9 | SIL OFL 1.1 (`pretendard.LICENSE`) |
| `rough.js` | `roughjs/bundled/rough.js`(판서의 손그림 선) | 4.6.6 | MIT (`rough.LICENSE`) |
| `NanumPenScript.woff2` | google/fonts `ofl/nanumpenscript/NanumPenScript-Regular.ttf`(판서 손글씨) | 2026-11-23 받음 | SIL OFL 1.1 (`NanumPenScript.LICENSE`) |

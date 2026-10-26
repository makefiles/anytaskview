# anytaskview

**English summary.** anytaskview is a Claude Code plugin that shows what Claude is doing on a live board in your local browser: the plan and its current step, a diagram Claude draws while it works, notes and decisions, and facts collected automatically by hooks (file edits, commands, subagents). Work that spans several conversations is grouped into projects, each with a big-picture board that stays until the work is done. You can point at a box or a step on the board and send a comment or instruction back to Claude. The board UI and Claude-facing texts are in Korean.

- Requirements: Claude Code with plugin support, Node.js 22.12 or later, Linux (macOS untested, Windows through WSL), a recent browser.
- Install: `claude plugin marketplace add makefiles/anytaskview`, then `claude plugin install anytaskview@anytaskview`. Step-by-step guide that an LLM agent can also follow: [INSTALL.md](INSTALL.md).
- Security: the board listens on 127.0.0.1 only and every request needs a token; nothing is sent off the machine. Details and limits: [SECURITY.md](SECURITY.md).
- License: Apache-2.0. Bundled browser libraries keep their own licenses (ELK: EPL-2.0, Mermaid: MIT).

---

Claude Code 가 일하는 동안 지금 하는 일을 이 PC 의 브라우저 화판에 실시간으로 보여 주는 플러그인입니다.

- Claude 가 계획(단계)과 문제 구조 그림, 이유·결정 메모를 짧은 도구 호출로 올립니다.
- 파일 수정, 명령, 하위 에이전트, 입력 필요 같은 사실은 Claude Code 훅이 자동으로 올립니다. 사실은 그때의 단계에 붙고, 그림 속 상자의 파일이 수정되면 그 상자에 「수정됨」 이 붙습니다.
- 여러 대화에 걸친 일은 프로젝트로 묶이고, 프로젝트마다 끝날 때까지 이어지는 큰 그림 화판이 있습니다.
- 화판의 상자나 단계를 가리켜 그 자리에서 Claude 에 의견·지시를 보낼 수 있습니다.

## 필요한 것

- Claude Code(플러그인을 쓰는 판)
- Node.js 22.12 이상. `PATH` 의 node 가 오래됐으면 nvm 으로 깐 node 를 찾아 쓰고, 그래도 없으면 `ANYTASKVIEW_NODE` 에 node 경로를 넣습니다.
- Linux 에서 만들고 시험했습니다. macOS 는 시험하지 않았고, Windows 는 WSL 에서 씁니다.
- Chrome·Edge·Firefox 같은 최근 브라우저

실행에 필요한 npm 패키지는 없습니다(브라우저 라이브러리는 `web/vendor/` 에 들어 있습니다).

## 설치

터미널에서:

```sh
claude plugin marketplace add makefiles/anytaskview
claude plugin install anytaskview@anytaskview
```

Claude Code 안에서는 `/plugin marketplace add makefiles/anytaskview` 와 `/plugin install anytaskview@anytaskview` 입니다. 이미 열려 있는 세션에서는 `/reload-plugins` 를 실행합니다.

자세한 순서와 확인 방법, 갱신·삭제는 [INSTALL.md](INSTALL.md) 에 있습니다.

### LLM 에게 설치를 맡기려면

Claude Code 같은 코딩 에이전트에 이렇게 말하면 됩니다.

> https://github.com/makefiles/anytaskview 의 INSTALL.md 를 읽고 그대로 설치하고 확인해 줘

INSTALL.md 는 에이전트가 그대로 따라 할 수 있도록 명령과 확인 기준을 단계마다 적었습니다. 화판 주소에는 비밀 값이 들어 있으므로 에이전트가 그 주소를 대화창에 옮겨 적지 않고, 사용자에게 브라우저로 직접 열도록 안내하게 했습니다.

## 처음 열기

1. Claude Code 세션 하나를 엽니다. 플러그인의 MCP 서버가 뜰 때 화판 서버(127.0.0.1:4871)도 뜹니다(이미 떠 있으면 그것을 씁니다).
2. 터미널에서 아래 명령이 찍는 주소를 이 PC 의 브라우저로 한 번 엽니다.

   ```sh
   "$(ls -td ~/.claude/plugins/cache/anytaskview/anytaskview/*/ | head -1)scripts/atv" board --url
   ```

3. 그 뒤로는 그 브라우저에서 `http://127.0.0.1:4871/` 만 열면 됩니다.

주소에는 읽기 토큰(`?t=`)과 화판 쓰기 열쇠(`#w=`)가 들어 있습니다. 다른 사람에게 보내거나 이슈·대화에 붙이지 마세요. `--url` 은 이 사용자의 화판 서버가 떠 있을 때만 주소를 줍니다.

## 화면

- 왼쪽: 세션 목록. 프로젝트별로 묶이고, 입력이 필요한 세션이 맨 위에 옵니다. 프로젝트 이름을 누르면 큰 그림이 열립니다.
- 가운데: Claude 가 그린 그림. 상자를 누르면 파일 경로를 복사합니다.
- 오른쪽: 계획(지금 단계는 위에 고정)과 타임라인(사실·메모·보낸 글). 타임라인은 「새 창」 으로 떼어 볼 수 있습니다.
- 아래: 재생 막대. 지난 상태를 처음부터 다시 봅니다.
- 상자나 단계에 마우스를 올리거나 초점을 두면 「보내기」 가 뜹니다. 여러 글을 「모아 두기」 로 모았다가 한꺼번에 보낼 수도 있습니다. 쓰다 둔 글과 모은 글은 브라우저를 닫아도 남습니다.
- 맨 위 「설정」 에서 이어받기 문구(예: `이어서 <키>`)를 정하면, 그 문구로 시작한 대화를 같은 키의 앞 대화와 프로젝트에 잇습니다. 기본은 꺼져 있습니다.
- 자세한 사용법은 화면의 「도움말」(`?` 키)에 있습니다.

## 데이터와 보안

- 화판 서버는 127.0.0.1 에만 묶이고, 모든 요청에 토큰이 필요합니다. 이 PC 밖으로 보내는 것은 없습니다.
- 기록은 `~/.local/state/anytaskview/` 에 이 사용자만 읽을 수 있게 둡니다(`ANYTASKVIEW_HOME` 으로 바꿀 수 있습니다). 사용자 입력과 명령 줄, 파일 경로가 들어가며 흔한 비밀 모양은 가립니다.
- 여러 사용자 계정이 함께 쓰는 컴퓨터에서는 권하지 않습니다(화판 서버가 꺼진 사이 다른 사용자가 포트를 잡으면 브라우저의 열쇠를 가로챌 수 있습니다).
- 남은 한계와 신고 방법은 [SECURITY.md](SECURITY.md) 에 있습니다.

## 문제 해결

- 화판이 안 뜸: Claude Code 세션을 새로 열거나, 위의 `scripts/atv board` 로 직접 띄웁니다. 로그는 `~/.local/state/anytaskview/board.log` 입니다.
- 「쓰기 열쇠 없음」 이 보임: `scripts/atv board --url` 의 주소로 다시 엽니다(다른 브라우저·시크릿 창·쿠키를 지운 경우).
- 플러그인을 갱신한 뒤 「화판 서버가 다른 판」 이라고 나옴: 옛 판 서버를 내립니다(INSTALL.md 「갱신」).
- node 를 찾지 못함: `ANYTASKVIEW_NODE=/path/to/node` 를 Claude Code 를 띄우는 환경에 넣습니다.

## 개발

```sh
npm install                  # 시험 도구와 브라우저 라이브러리 원본(실행에는 필요 없음)
npm test                     # 장면 규칙, 서버 보안, 훅, MCP, 선 길 찾기
node verify/probe_ui.js      # 화면 없는 Chrome 으로 화면 확인(Chrome 필요)
claude --plugin-dir .        # 이 폴더를 한 세션에만 붙여 시험
```

구조와 동작의 자세한 규칙은 [docs/internals.md](docs/internals.md) 에 있습니다.

## 라이선스

Apache License 2.0 ([LICENSE](LICENSE)). `web/vendor/` 의 ELK(EPL-2.0)와 Mermaid(MIT)는 각자의 라이선스를 따릅니다([web/vendor/README.md](web/vendor/README.md)).

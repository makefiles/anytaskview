# 보안

**English summary.** anytaskview is a local tool. The board server binds to 127.0.0.1 only, checks the Host header, and requires a token on every request: a write key for hooks and the MCP server, a read token (HttpOnly cookie) for the browser, and a separate board key (kept in the page's localStorage and sent as a header from the same origin) for browser writes. Nothing is sent off the machine, except that an HTML document opened in the document viewer may load scripts, styles and fonts from public CDNs (cdnjs, jsDelivr, unpkg, Google Fonts). The document viewer reads the Markdown and HTML files the agent wrote or a diagram box points to, plus Markdown, HTML and image files in the same git repository (or, outside a repository, that folder and everything below it); HTML runs in a sandboxed iframe without access to the board. Records live in `~/.local/state/anytaskview/` with owner-only permissions and contain prompts, command lines, file paths, the agent's answers (up to 4,000 characters) and the changed lines of each file edit (up to 16 KB per edit by default, adjustable from off to 512 KB in 16 KB steps in Settings); common secret patterns are masked but not all. Anyone who has the board URL can read every session and send instructions to Claude or Codex, so treat it like a password. Messages to Codex sessions are passed to `codex queue` as a command-line argument (no shell), so other local users may see them briefly in the process list. On a computer shared with other user accounts, another user who takes port 4871 while your board server is down can capture your browser keys when you open the board; use it on a single-user machine. Report vulnerabilities privately through GitHub's Security tab.

## 무엇을 지키는가

이 PC 에서 한 사용자가 쓰는 도구입니다. 다음을 막으려고 합니다.

- 다른 웹사이트가 브라우저를 통해 화판을 읽거나 쓰는 것(CSRF, DNS rebinding)
- 같은 PC 의 다른 사용자가 기록 파일을 읽거나, 훅·MCP 의 쓰기 열쇠를 받아 가는 것(브라우저 쪽은 아래 「남은 한계」)
- 화판에 올라가는 글에 비밀 값이 그대로 남는 것

## 어떻게 지키는가

- 화판 서버는 `127.0.0.1` 에만 묶이고, `Host` 머리글이 `127.0.0.1:<포트>` 나 `localhost:<포트>` 가 아니면 거절합니다.
- 열쇠는 상태 폴더의 `key.json`(파일 0600, 폴더 0700)에 처음 실행할 때 무작위로 만듭니다. 열쇠는 셋입니다.
  - 쓰기 열쇠: 훅과 MCP 서버가 `X-ATV-Key` 머리글로 보냅니다. `Origin` 이 붙은 요청(브라우저)은 열쇠가 맞아도 받지 않습니다.
  - 읽기 토큰: 브라우저가 처음 `?t=` 주소로 열면 `HttpOnly; SameSite=Strict` 쿠키가 되고, 주소에서는 지웁니다.
  - 화판 쓰기 열쇠: 처음 주소의 `#w=` 로 와서 그 페이지의 localStorage 에 들어갑니다. 브라우저 쓰기(이름, 프로젝트, 설정, 지우기, 도형 자리, Claude 에 보내기)는 이 열쇠(`X-ATV-Board`), 읽기 쿠키, `Host` 와 정확히 같은 `Origin`, JSON 본문(256KiB 이하)이 모두 맞을 때만 받습니다. 쿠키는 같은 PC 의 다른 포트로도 가므로 쓰기에는 포트별로 갈라지는 localStorage 의 열쇠를 따로 씁니다. 다른 사이트가 맞춤 머리글을 붙이려면 사전 확인(OPTIONS)을 거쳐야 하는데 서버는 답하지 않습니다.
- 화면에는 `Content-Security-Policy`(자기 출처의 스크립트만, 외부 연결 없음, 틀은 같은 서버의 문서만), `X-Frame-Options: DENY`, `nosniff`, `no-referrer` 를 붙입니다. 브라우저 라이브러리(ELK, Mermaid, markdown-it, DOMPurify)는 저장소에 들어 있어 외부에서 받지 않습니다.
- 문서 보기(「문서」 탭과 문서 창)는 화판 서버가 디스크의 파일을 읽어 보내는 유일한 길입니다. 목록에는 그 세션 범위(화판 프로젝트, 아니면 이어진 대화)의 수정 사실과 그림 상자가 가리키는 md·html 만 오릅니다. 파일은 `/doc/<열쇠>/<경로>` 로 읽는데, 열쇠는 목록 문서가 든 git 저장소의 최상위(저장소가 아니면 그 문서 폴더)마다 서버가 무작위로 만들어 메모리에 두는 값으로, 읽기 쿠키를 확인한 목록 API 로만 나가고 서버를 다시 띄우면 바뀝니다. 그 열쇠로는 그 뿌리 안(실제 경로 기준, 링크로 밖을 가리키면 거절)의 md·markdown·html·htm(2MiB 까지)과 그림 png·jpg·jpeg·gif·webp·svg(10MiB 까지)만 읽고(링크면 가리키는 실제 파일의 확장자도 봄. 저장소 안의 링크로 목록에 오른 문서가 저장소 밖을 가리키면 그 밖을 새 범위로 열지 않음), `..` 따위로 뿌리 밖을 가리키는 주소는 거절합니다. 주소에 경로 대신 열쇠를 쓰는 것은 html 을 여는 격리 틀이 쿠키를 보내지 못하기 때문입니다.
- md 는 화면에서 markdown-it 로 그린 뒤 DOMPurify 로 정화합니다(스크립트·이벤트 속성·`style`·폼·틀을 지우고, `id`·`name` 은 화판 요소와 겹치지 않게 앞말을 붙임). 바깥 그림은 화면 CSP 가 막아 대체 글로 보입니다.
- html 은 `allow-same-origin` 이 없는 `sandbox` iframe 에서 열려 화판과 출처가 다릅니다. 화판의 쿠키·열쇠·화면에 닿지 못하고, 문서 응답의 CSP 가 연결(`connect-src 'none'`)·폼·위쪽 틀 이동을 막습니다. 스크립트는 파일 안의 것과 공개 CDN 셋(cdnjs·jsDelivr·unpkg)의 것만 돌고, 글꼴·스타일은 그 CDN 과 Google 글꼴에서 받을 수 있습니다(사용자 결정 2026-10-30).
- Linux 에서는 훅, MCP, `scripts/atv board --stop`·`--url` 이 열쇠를 보내거나 주소를 주기 전에 `/proc/net/tcp`·`tcp6` 으로 그 포트를 이 사용자가 듣고 있는지 봅니다(IPv4 주소, IPv6 의 모든 주소, IPv4 를 옮긴 IPv6 주소). 다른 사용자가 포트를 잡았거나 아무도 듣지 않으면 열쇠를 보내지 않고 주소도 주지 않습니다.
- 훅은 도구의 출력을 보내지 않습니다. 사용자 입력(4,000자), 명령 줄(200자), 파일 경로, 에이전트의 차례 끝 답(4,000자), 파일 수정의 바뀐 줄(diff), 하위 에이전트의 설명(80자) 같은 사실만 보냅니다. 하위 에이전트의 설명은 Agent 도구의 입력과, Claude Code 가 세션 기록 옆에 남기는 `subagents/…/agent-<id>.meta.json` 의 `description` 에서 읽습니다(심볼릭 링크·64KB 넘는 파일은 읽지 않음). 다만 답에는 에이전트가 옮겨 적은 파일 내용·명령 출력이 들어갈 수 있습니다. 보내는 글에서는 흔한 비밀 모양(개인 키, `Authorization` 값, JWT, `token=`·`password=` 같은 값, 잘 알려진 토큰 접두, 주소 안의 비밀번호)을 가립니다.
- 바뀐 줄은 파일 내용의 일부입니다. 훅은 수정 한 번에 512KB 까지 줄마다 가려 보내고(개인 키는 BEGIN~END 줄을 모두 가리고, 개인 키 파일 `.pem`·`.key`·`id_rsa` 따위는 바뀐 줄을 보내지 않음), 화판 서버는 설정한 크기(기본 16KB, 「끔」 이면 더하기·빼기 줄 수만)로 잘라 기록에 남깁니다. 화면에는 그 줄을 누를 때만 보냅니다.
- 받은 글은 화면에 글자로만 넣습니다. HTML 을 넣는 곳은 Mermaid 가 `strict` 로 만든 SVG(그 안의 링크는 벗겨 냄)와 위의 정화한 md 뿐입니다. 누르면 복사되는 경로에는 제어 문자를 받지 않습니다.
- 화판에서 Claude 에 보낸 글은 「사용자가 이 PC 의 화판에서 직접 쓴 글」 이라는 출처를 붙여 넘기며, Claude Code 는 이것을 승인으로 쓰지 않습니다.
- Codex 세션에 보내는 글은 화판 서버가 `codex queue --thread <세션> --message <글>` 을 셸 없이 인자 배열로 불러 넘깁니다. 실행 파일은 그 세션을 띄운 codex(이름이 `codex` 인 것만)이고, 안 되면 `PATH` 의 codex 입니다. Codex 에서는 이 글이 사용자 입력과 같은 차례로 들어갑니다(승인 창을 대신하지는 못합니다).
- Codex 의 그리기 도구 허용(INSTALL 의 C2)은 화판에 쓰는 다섯 도구에만 겁니다. Codex 는 플러그인 훅을 사용자가 `/hooks` 에서 믿기 전에는 돌리지 않습니다.
- 이 PC 밖으로 보내는 것은 없습니다. 예외는 문서 창에서 연 html 이 부르는 공개 CDN·Google 글꼴 요청입니다(그 문서를 열 때만, 주소에 화판 열쇠는 실리지 않음).

## 남은 한계

- **화판 주소는 비밀번호처럼 다루세요.** 주소(또는 그 브라우저)를 가진 사람은 모든 세션의 기록을 읽고 Claude 에 지시를 보낼 수 있습니다. 주소를 이슈나 대화에 붙이지 마세요.
- 비밀 가리기는 흔한 모양만 잡습니다. 붙여 넣은 비밀이 다른 모양이면 기록에 남습니다.
- 기록은 상태 폴더에 평문으로 남습니다(이 사용자만 읽을 수 있음). 수정의 바뀐 줄도 그렇습니다. 남기고 싶지 않으면 설정의 「수정 내용(diff) 보관」 을 「끔」 으로 둡니다. 이미 남은 기록은 지우지 않습니다. 쓰다 둔 글과 모은 글은 브라우저의 localStorage 에 평문으로 남습니다.
- **여러 사용자 계정이 쓰는 컴퓨터에서는 쓰지 않는 것이 좋습니다.** 화판 서버가 꺼져 있는 사이 다른 사용자가 4871 포트를 잡으면, 그 뒤 브라우저로 `http://127.0.0.1:4871/` 을 열 때 읽기 쿠키가 그쪽으로 가고, 그쪽 페이지가 같은 주소의 localStorage 에 든 화판 쓰기 열쇠와 쓰다 둔 글을 읽을 수 있습니다. 로컬 HTTP 의 한계라 이 도구로는 막지 못합니다(`--url` 이 남이 잡은 포트에는 주소를 주지 않는 것까지만 합니다).
- macOS 등 `/proc` 가 없는 시스템에서는 포트 주인을 확인하지 못해, 다른 사용자가 포트를 먼저 잡으면 훅·MCP 의 쓰기 열쇠도 그쪽으로 갈 수 있습니다.
- 같은 PC 의 다른 로컬 웹 서버(다른 포트)가 악의적이면 읽기 쿠키를 받을 수 있습니다(쿠키는 포트를 가리지 않음). 쓰기에는 별도 열쇠가 필요합니다.
- 문서 보기의 범위는 「목록 문서가 든 저장소 전체」 입니다. 홈 폴더처럼 넓은 폴더에 `.git` 이 있으면 그 아래의 md·html·그림을 모두 읽을 수 있게 됩니다(읽기 쿠키를 가진 브라우저와, 열쇠가 든 문서 주소를 가진 쪽). 문서 창에서 연 html 은 그 안의 스크립트가 돌며, 화판에는 닿지 못해도 그 페이지 안에서는 무엇이든 보여 줄 수 있고, 자기 내용과 자기 주소(문서 열쇠 포함)를 새 창이나 틀 이동으로 바깥에 보낼 수 있습니다. 그 열쇠는 이 PC 의 브라우저 밖에서는 쓸 수 없고, 다른 사이트는 그 주소의 응답을 읽지 못합니다(CORS, 화판 서버는 CORS 를 열지 않음). 화판은 html 끝에 문서 링크·Esc 를 알리는 짧은 스크립트를 붙이며, 그 알림으로는 같은 열쇠 아래의 문서를 문서 창에 열거나 창을 닫는 것만 됩니다. 그 html 이 CDN 을 부르면 CDN 이 이 PC 의 주소와 여는 시각을 압니다.
- Codex 에 보내는 글은 `codex queue` 의 명령 줄 인자로 넘어가므로, 보내는 1초 남짓 동안 같은 PC 의 다른 사용자가 프로세스 목록(`/proc/<pid>/cmdline`)으로 볼 수 있습니다(`hidepid` 를 켜지 않은 Linux). `codex queue` 가 글을 표준 입력으로 받지 않아 이렇게 합니다.

## 열쇠 바꾸기

열쇠가 새었다고 생각되면 화판 서버를 멈추고(`scripts/atv board --stop`) 상태 폴더의 `key.json` 을 지운 뒤 서버를 다시 띄우고, `scripts/atv board --url` 로 새 주소를 받아 브라우저에서 다시 엽니다. 훅과 MCP 는 새 열쇠를 다시 읽습니다.

## 취약점 알리기

GitHub 저장소의 Security 탭에서 비공개로 알려 주세요. 그 기능이 꺼져 있으면 이슈에 재현 방법만 적고, 열쇠·주소·기록 내용은 적지 마세요.

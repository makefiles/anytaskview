# anytaskview 설치 안내

**English summary.** Step-by-step install, verify, update and uninstall for the anytaskview Claude Code plugin, and the same for OpenAI Codex (CLI, desktop app, VS Code) in the last part. Each step has a command and a success check, so an LLM coding agent can follow it as written. Rules for agents: do not print or paste the board URL (it carries a read token and a write key) into chat or logs; ask the user to open it in their own browser; ask before deleting anything or editing the user's Codex config.

사람도 그대로 따라 할 수 있지만, Claude Code 같은 코딩 에이전트에 「이 문서를 읽고 그대로 설치하고 확인해 줘」 라고 맡기도록 썼습니다.

## 에이전트가 지킬 것

- 단계마다 명령을 실행하고 「확인」 의 기준을 본 뒤 다음 단계로 갑니다. 기준이 맞지 않으면 멈추고 그 출력을 사용자에게 보여 줍니다.
- 화판 주소(`scripts/atv board --url` 의 출력)는 읽기 토큰과 쓰기 열쇠를 담고 있습니다. 대화창이나 로그, 이슈에 옮겨 적지 말고, 사용자에게 명령을 알려 주어 직접 열게 합니다.
- 브라우저 창은 사용자가 원할 때만 엽니다.
- 상태 폴더(`~/.local/state/anytaskview/`)나 플러그인 폴더를 지우는 일은 사용자에게 먼저 묻습니다.
- 전역 설정(`git config --global`, 셸 시작 파일 등)은 바꾸지 않습니다. `ANYTASKVIEW_NODE` 가 필요하면 사용자에게 어디에 둘지 묻습니다.

## 0. 필요한 것 확인

```sh
claude --version
node --version
uname -s
```

확인:
- `claude` 가 판을 찍습니다(플러그인 명령이 있는 Claude Code). `claude plugin --help` 가 `marketplace`·`install` 을 보여 주면 됩니다.
- `node` 가 22.12 이상입니다. 낮거나 없으면 nvm 등으로 22.12 이상을 깝니다. `PATH` 의 node 가 오래됐어도 `~/.nvm/versions/node/*/bin/node` 에 22.12 이상이 있으면 그것을 씁니다. 다른 곳에 있으면 그 경로를 `ANYTASKVIEW_NODE` 로 Claude Code 를 띄우는 환경에 넣어야 합니다.
- `uname -s` 가 `Linux` 입니다. `Darwin`(macOS)은 시험하지 않았으므로 사용자에게 알리고 계속할지 묻습니다. Windows 는 WSL 안에서 설치합니다.

## 1. 마켓플레이스 더하기

```sh
claude plugin marketplace add makefiles/anytaskview
```

확인: `claude plugin marketplace list` 에 `anytaskview` 가 보입니다. 이미 있다는 오류면 다음 단계로 갑니다.

## 2. 플러그인 설치

```sh
claude plugin install anytaskview@anytaskview
```

확인: `claude plugin list` 에 `anytaskview@anytaskview` 가 있고 `Status: ✔ enabled` 입니다.

플러그인 폴더(아래에서 `$ATV`)는 이렇게 찾습니다.

```sh
ATV="$(ls -td ~/.claude/plugins/cache/anytaskview/anytaskview/*/ | head -1)"
echo "$ATV"
```

확인: `$ATV` 가 `.../anytaskview/anytaskview/<판>/` 이고 `ls "$ATV/scripts/atv"` 가 파일을 찾습니다.

## 3. 화판 서버 띄우기와 확인

화판 서버는 플러그인을 켠 Claude Code 세션이 시작될 때 함께 뜹니다. 설치를 하는 이 세션은 플러그인을 켜기 전에 시작됐으므로 직접 띄웁니다.

```sh
"$ATV/scripts/atv" board >/dev/null 2>&1 &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4871/
```

확인: `401` 이 찍힙니다(서버가 떠 있고, 토큰 없이는 잠긴 화면을 준다는 뜻). `000` 이면 `~/.local/state/anytaskview/board.log` 의 마지막 줄을 사용자에게 보여 줍니다. 4871 포트를 다른 프로그램이 쓰고 있으면 그 사실을 알리고 멈춥니다.

## 4. 브라우저로 열기(사용자가 직접)

사용자에게 아래 명령을 터미널에서 직접 실행하고, 찍힌 주소를 이 PC 의 브라우저로 한 번 열라고 안내합니다. 에이전트는 이 명령을 실행해 출력을 읽지 않습니다.

```sh
"$(ls -td ~/.claude/plugins/cache/anytaskview/anytaskview/*/ | head -1)scripts/atv" board --url
```

그 뒤로는 그 브라우저에서 `http://127.0.0.1:4871/` 만 열면 됩니다(읽기 쿠키는 1년, 쓰기 열쇠는 그 브라우저에 남습니다).

`--url` 은 이 사용자의 화판 서버가 떠 있을 때만 주소를 줍니다. 「떠 있지 않습니다」 나 「다른 사용자의 프로그램」 이 나오면 3단계로 돌아가 확인합니다.

확인(사용자): 화판이 열리고 맨 위에 「쓰기 열쇠 없음」 이 보이지 않습니다.

## 5. 세션에서 확인

이미 열려 있는 Claude Code 세션에서는 `/reload-plugins` 를 실행합니다. 새 세션은 그대로 됩니다.

세션에서 Claude 에게 「anytaskview 화판에 이 작업 계획을 올려 줘」 라고 하면 `plan` 도구를 부릅니다.

확인(사용자): 화판 왼쪽 목록에 그 세션이 보이고, 오른쪽에 계획이 나타납니다.

## 갱신

```sh
OLD="$(ls -td ~/.claude/plugins/cache/anytaskview/anytaskview/*/ | head -1)"
claude plugin marketplace update anytaskview
claude plugin update anytaskview@anytaskview
"$OLD/scripts/atv" board --stop
```

떠 있던 서버는 옛 판의 화면을 내주므로 내립니다. 그다음 세션이 새 판 서버를 띄웁니다(바로 띄우려면 3단계). 열린 세션에서는 `/reload-plugins`, 브라우저의 화판 탭은 모두 새로 고칩니다.

## 삭제

```sh
"$(ls -td ~/.claude/plugins/cache/anytaskview/anytaskview/*/ | head -1)scripts/atv" board --stop
claude plugin uninstall anytaskview@anytaskview
claude plugin marketplace remove anytaskview
```

기록(세션별 화판 기록, 프로젝트, 열쇠)은 `~/.local/state/anytaskview/` 에 남습니다. 지울지는 사용자에게 묻고, 지우라고 하면 그 폴더를 지웁니다. 브라우저에 남은 쓰다 둔 글은 그 브라우저의 `127.0.0.1:4871` 사이트 데이터를 지우면 사라집니다.

## Codex 에 설치

같은 저장소가 OpenAI Codex 의 플러그인이기도 합니다(`.codex-plugin/`). 터미널의 `codex`(대화형·`codex exec`), ChatGPT 데스크톱 앱과 VS Code 의 Codex 가 같은 `~/.codex` 설치를 씁니다. 화판 서버·상태 폴더·브라우저 주소는 Claude Code 와 같아서, 두 쪽을 함께 쓰면 한 화판에 함께 보입니다. 화판을 처음 띄우고 여는 일은 위 3·4단계와 같습니다(플러그인 폴더만 `~/.codex/plugins/cache/anytaskview/anytaskview/*/` 입니다).

두 쪽을 함께 쓰면 Claude Code 플러그인도 같은 판으로 갱신합니다. 화판 서버는 하나라서, 옛 판 서버가 떠 있으면 Codex 세션을 알아보지 못합니다(도구 결과에 「화판 서버가 다른 판입니다」 가 붙으면 위 「갱신」 처럼 서버를 내립니다).

### C0. 필요한 것

```sh
codex --version
```

확인: `codex-cli 0.163.0` 이상에서 시험했습니다. 데스크톱 앱·VS Code 는 그 앱에 든 codex 판을 쓰므로 판이 다를 수 있고, 아주 옛 판이면 훅이나 세션 구분이 동작하지 않을 수 있습니다.

### C1. 마켓플레이스 더하기와 플러그인 설치

```sh
codex plugin marketplace add makefiles/anytaskview
codex plugin add anytaskview@anytaskview
```

확인: `codex plugin list` 에 `anytaskview@anytaskview` 가 설치됨으로 보입니다.

### C2. 그리기 도구를 늘 허용(사용자 설정)

Codex 는 MCP 도구를 부를 때마다 승인을 묻고, `codex exec` 에서는 묻지 못해 호출이 실패합니다. 플러그인이 스스로 허용할 수는 없으므로 사용자 Codex 설정 `~/.codex/config.toml` 에 아래 줄을 더합니다. 에이전트는 이 내용을 보여 주고 사용자 허락을 받은 뒤 파일 끝에 붙입니다. 이미 같은 표가 있으면 붙이지 않습니다.

```toml
[plugins."anytaskview@anytaskview".mcp_servers.anytaskview.tools.plan]
approval_mode = "approve"

[plugins."anytaskview@anytaskview".mcp_servers.anytaskview.tools.draw]
approval_mode = "approve"

[plugins."anytaskview@anytaskview".mcp_servers.anytaskview.tools.note]
approval_mode = "approve"

[plugins."anytaskview@anytaskview".mcp_servers.anytaskview.tools.ids]
approval_mode = "approve"

[plugins."anytaskview@anytaskview".mcp_servers.anytaskview.tools.project]
approval_mode = "approve"
```

이 다섯 도구는 화판에 그림·계획·메모를 쓰기만 하고, 파일이나 명령에는 손대지 않습니다. 허용 범위도 이 다섯 도구로 한정됩니다.

### C3. 훅 믿기(사용자가 직접)

Codex 는 플러그인의 훅을 사용자가 검토하고 믿기 전에는 돌리지 않습니다. 사용자에게 `codex` 를 띄워 `/hooks` 에서 anytaskview 훅을 검토하고 믿어 달라고 안내합니다. 갱신으로 훅 정의가 바뀌면 다시 믿어야 합니다. 훅이 돌지 않으면 그리기는 되지만 명령·파일 수정 같은 사실이 오르지 않고, 화판 목록에 「Codex」 표시가 붙지 않으며 화판에서 보낼 수 없습니다.

### C4. 세션에서 확인

새 Codex 세션을 열고 「anytaskview 화판에 이 작업 계획을 올려 줘」 라고 합니다.

확인(사용자): 화판 왼쪽 목록에 그 세션이 「Codex · …」 로 보이고, 오른쪽에 계획이 나타납니다. 세션 줄 ⋯ 「메시지 보내기…」 로 보낸 글을 Codex 가 받습니다(쉬는 세션은 깨우고, 일하는 중이면 그 차례가 끝난 뒤 받습니다).

### Codex 갱신·삭제

```sh
codex plugin marketplace upgrade anytaskview
```

갱신한 뒤 새 세션을 열고, 훅 정의가 바뀌었으면 `/hooks` 에서 다시 믿습니다. 화판 서버를 내리는 일은 위 「갱신」 과 같습니다.

```sh
"$(ls -td ~/.codex/plugins/cache/anytaskview/anytaskview/*/ | head -1)scripts/atv" board --stop
codex plugin remove anytaskview@anytaskview
codex plugin marketplace remove anytaskview
```

화판 서버를 먼저 내립니다(지운 폴더의 서버가 포트를 쥐고 남지 않게). Claude Code 플러그인을 계속 쓰면 다음 Claude 세션이 다시 띄웁니다. C2 에서 더한 줄은 사용자에게 물은 뒤 지웁니다.

## 바꿀 수 있는 값(환경 변수)

| 이름 | 뜻 | 기본 |
|---|---|---|
| `ANYTASKVIEW_NODE` | 쓸 node 경로 | `PATH` → nvm 에서 22.12 이상을 찾음 |
| `ANYTASKVIEW_HOME` | 상태 폴더 | `~/.local/state/anytaskview` |
| `ANYTASKVIEW_PORT` | 화판 포트 | `4871` |
| `ANYTASKVIEW_AUTOSTART` | `0` 이면 세션이 화판 서버를 띄우지 않음 | 켜짐 |
| `ANYTASKVIEW_NUDGE_AFTER` | 그림 없이 도구를 몇 번 넘게 쓰면 Claude·Codex 에 그리라고 알릴지 | `8` |

Codex 는 플러그인 MCP 서버에 부모 환경을 넘기지 않고, 사용자 설정으로 플러그인 MCP 서버의 환경을 정할 수도 없습니다(0.163 확인). 그래서 Codex 에서는 위 값들을 바꾸지 말고 기본값(포트 4871, 상태 폴더 `~/.local/state/anytaskview`, 자동 시작)으로 씁니다. 훅만 바뀐 값을 받아 그림과 사실이 서로 다른 화판에 갈 수 있습니다. node 는 실행기가 한 번 찾은 경로를 기본 상태 폴더에 기억해 MCP 서버도 같이 씁니다.

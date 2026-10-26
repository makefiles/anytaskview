// 화판에 올라가는 글(명령 줄, 사용자 입력, 마지막 답)에서 흔한 비밀 모양을 가린다.
// 모든 비밀을 잡지는 못한다. 붙여 넣은 토큰이나 명령 줄의 값이 기록에 남는 흔한 경우를 줄이려는 것이다.
// $VAR 처럼 다른 변수를 가리키는 값은 가리지 않는다(값이 아니라 이름이므로).

const RULES = [
  // 붙여 넣은 개인 키 본문
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "-----BEGIN PRIVATE KEY----- ***"],
  // Authorization 헤더 값과 Bearer 토큰. 보통 문장의 "Basic auth" 같은 말까지 가리지 않게 헤더 모양일 때만
  [/(\bAuthorization\s*:\s*)(?:(Basic|Bearer|Token)\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, (_m, head, scheme) => `${head}${scheme ? scheme + " " : ""}***`],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 ***"],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "***"],
  // 이름에 token·pass·secret·key 가 든 변수·속성에 값을 넣는 모양(KEY=값, --api-key=값, "token": "값")
  [/\b([A-Za-z0-9_-]*(?:token|passwd|password|pass|pwd|secret|key)[A-Za-z0-9_-]*)(["']?)(\s*[=:]\s*)(?![$"']?\$)("[^"]*"|'[^']*'|[^\s"'&|;,)}]+)/gi, "$1$2$3***"],
  // 띄어 쓴 옵션 값(--password 값, --token 값)
  [/(\s--?(?:password|passwd|pass|token|api-?key|secret)\s+)(?![-$]|["']\$)("[^"]*"|'[^']*'|\S+)/gi, "$1***"],
  // mysql 계열의 -p비밀번호(붙여 씀). find -print 같은 다른 명령의 -p 는 건드리지 않게 이 명령들에서만
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^|;&\n]*?\s-p)(?![\s$])\S+/gi, "$1***"],
  // sshpass -p 값, curl -u 사용자:비밀번호
  [/(\bsshpass\s+-p\s*)(?!\$)\S+/g, "$1***"],
  [/(\s-u\s+["']?[^\s:"']+:)(?!\$)[^\s"']+/g, "$1***"],
  // 잘 알려진 토큰 접두
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "***"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "***"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "***"],
  // 주소에 넣은 사용자:비밀번호
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi, "$1***@"],
];

export function redact(text) {
  if (typeof text !== "string" || !text) return "";
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

// 앞 n 자만 남기고 가린다. 먼저 잘라서 가리므로 아주 긴 입력에도 정규식이 오래 돌지 않는다.
// 잘린 끝에 걸친 값도 가려지도록 n 보다 조금 넉넉히 잘라 가린 뒤 다시 자른다
export function clip(text, n) {
  const t = redact(String(text ?? "").slice(0, n + 64));
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

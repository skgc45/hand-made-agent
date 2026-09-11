import {
  type Rule,
  type Subject,
  formatRule,
  hits,
  parseRule,
  subjectsOf,
} from "./rules.js";

export type PermissionSet = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
};

export type Decision = "allow" | "ask" | "deny";

export type Permissions = {
  decide(name: string, args: unknown): Decision;
  /** [a]lways の行き先。プロセスが生きている間だけ有効（永続化はステップ8） */
  allowForSession(text: string): void;
  /** 承認 UI に出す初期値。当たるルールを作れないときは undefined */
  suggestRule(name: string, args: unknown): string | undefined;
};

/** コマンド置換は中身を別に評価しないと素通りするので、allow には一致させない */
const INJECTION = /\$\(|`/;

/** plan は ask と同じ判定。止める範囲は deny ルールに展開して渡される */
const MODES = ["ask", "auto", "plan"];

export function createPermissions(
  set: PermissionSet,
  mode: string,
): Permissions {
  if (!MODES.includes(mode)) {
    throw new Error(`APPROVAL に不明な値: ${mode}（${MODES.join(" / ")}）`);
  }

  const parse = (list?: string[]) => (list ?? []).map(parseRule);
  const deny = parse(set.deny);
  const allow = parse(set.allow);
  const ask = parse(set.ask);
  const session: Rule[] = [];

  const safe = (subject: Subject | undefined) =>
    !(subject?.kind === "command" && INJECTION.test(subject.value));

  return {
    decide(name, args) {
      const subjects = subjectsOf(args);
      const any = (rules: Rule[]) =>
        subjects.some((subject) => rules.some((r) => hits(r, name, subject)));

      // deny が最優先。auto でも素通りさせない
      if (any(deny)) return "deny";
      if (mode === "auto") return "allow";

      // 連結コマンドは全部の区間が allow に当たったときだけ通す
      const allowed = subjects.every(
        (subject) =>
          safe(subject) &&
          [...allow, ...session].some((r) => hits(r, name, subject)),
      );
      if (allowed) return "allow";

      return any(ask) ? "ask" : "allow";
    },

    allowForSession(text) {
      session.push(parseRule(text));
    },

    suggestRule(name, args) {
      const subjects = subjectsOf(args);
      // 区間が複数あると1つ許可しても残りで止まる。当たらないルールは勧めない
      if (subjects.length !== 1) return undefined;

      const [subject] = subjects;
      if (!subject) return name;
      if (!safe(subject)) return undefined;

      return formatRule({
        tool: name,
        pattern:
          subject.kind === "command" ? `${subject.value}:*` : subject.value,
      });
    },
  };
}

export * from "./rules.js";

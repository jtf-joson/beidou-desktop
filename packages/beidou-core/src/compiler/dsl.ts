/**
 * 口径 DSL 编译(ARCHITECTURE A3:口径一致性的根基)。
 * 两个入口:
 *  - compileFormula:平台 caliber.formula JSON AST → SQL 表达式
 *  - compileFilterExpr:平台 filters[].expr DSL 文本 → SQL 谓词
 * 原则:白名单运算符/函数;标识符一律经 ctx 解析;字符串字面量转义;任何解析失败 fail-closed。
 */
import { err, ok, type Result } from "../types";

export interface CompileCtx {
  /** 数据集列 → 物理列名(返回 null = 解析不了) */
  resolveColumn: (dataset: string, column: string) => string | null;
  /** 指标 code(mc…) → 该指标的公式 AST(返回 null = 解析不了) */
  resolveMetricCode: (code: string) => unknown;
}

const SQL_FUNCS = new Set([
  "count", "sum", "avg", "min", "max", "abs", "round", "floor", "ceil", "ceiling",
  "coalesce", "if", "ifnull", "nullif", "greatest", "least", "stddev", "stddev_samp",
  "stddev_pop", "variance", "var_samp", "var_pop", "concat", "length", "char_length",
  "lower", "upper", "date_diff", "datediff", "date_trunc", "to_date", "year", "month", "day",
]);
const SQL_BINOPS = new Set(["+", "-", "*", "/", "%", "=", "!=", "<>", ">", "<", ">=", "<="]);
const MAX_DEPTH = 20;

interface FormulaNode {
  type?: string | null;
  op?: string | null;
  args?: unknown;
  x?: unknown;
  y?: unknown;
  val?: unknown;
  path?: unknown;
}

const isNode = (n: unknown): n is FormulaNode =>
  typeof n === "object" && n !== null;

const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** 限定标识符:seg 或 seg.seg(允许 t.col / d0.col 形态) */
const isQualifiedIdent = (s: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);

export function compileFormula(node: unknown, ctx: CompileCtx, depth = 0): Result<string> {
  if (depth > MAX_DEPTH) return err("DSL_DEPTH", "公式嵌套过深");
  if (!isNode(node) || typeof node.type !== "string") return err("DSL_NODE", "非法公式节点");
  switch (node.type) {
    case "NAME_REF": {
      const path = node.path;
      if (!Array.isArray(path) || path.length === 0 || path.some((p) => typeof p !== "string")) {
        return err("DSL_REF", "NAME_REF path 非法");
      }
      if (path.length === 1) {
        const sub = ctx.resolveMetricCode(path[0]!);
        if (sub === null || sub === undefined) return err("UNRESOLVED_REF", `无法解析指标引用 ${path[0]}`);
        return compileFormula(sub, ctx, depth + 1);
      }
      if (path.length !== 2) return err("DSL_REF", `NAME_REF path 长度不支持:${path.length}`);
      const col = ctx.resolveColumn(path[0]!, path[1]!);
      if (col === null) return err("UNRESOLVED_REF", `数据集列未在血缘映射中:${path[0]}.${path[1]}`);
      if (!isQualifiedIdent(col)) return err("DSL_IDENT", `列名不合法:${col}`);
      return ok(col);
    }
    case "CONSTANT": {
      const v = node.val;
      if (v === null) return ok("NULL");
      if (typeof v === "number" && Number.isFinite(v)) return ok(String(v));
      if (typeof v === "boolean") return ok(v ? "TRUE" : "FALSE");
      if (typeof v === "string") return ok(quoteLiteral(v));
      return err("DSL_CONST", `不支持的字面量类型:${typeof v}`);
    }
    case "CALL_OP": {
      const op = typeof node.op === "string" ? node.op.toLowerCase() : "";
      if (!/^[a-z_][a-z0-9_]*$/.test(op) || !SQL_FUNCS.has(op)) {
        return err("DSL_FUNC", `函数不在白名单:${node.op}`);
      }
      const args = Array.isArray(node.args) ? node.args : [];
      const parts: string[] = [];
      for (const a of args) {
        const r = compileFormula(a, ctx, depth + 1);
        if (!r.ok) return r;
        parts.push(r.value);
      }
      return ok(`${op}(${parts.join(", ")})`);
    }
    case "BIN_OP": {
      const op = node.op ?? "";
      if (typeof op !== "string" || !SQL_BINOPS.has(op)) return err("DSL_OP", `运算符不在白名单:${op}`);
      if (!isNode(node.x) || !isNode(node.y)) return err("DSL_NODE", "BIN_OP 缺 x/y");
      const lx = compileFormula(node.x, ctx, depth + 1);
      if (!lx.ok) return lx;
      const ly = compileFormula(node.y, ctx, depth + 1);
      if (!ly.ok) return ly;
      return ok(`(${lx.value} ${op} ${ly.value})`);
    }
    default:
      return err("DSL_NODE", `未知节点类型:${node.type}`);
  }
}

// ---------------------------------------------------------------------------
// 过滤 DSL 文本解析:((['ds'/'col']) OP (literal)) [AND|OR ...]
// ---------------------------------------------------------------------------

type FTok =
  | { t: "ref"; ds: string; col: string }
  | { t: "num"; v: string }
  | { t: "str"; v: string }
  | { t: "word"; v: string }
  | { t: "op"; v: string }
  | { t: "punct"; v: string };

function lexFilter(src: string): FTok[] | null {
  const toks: FTok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    // ['ds'/'col']
    if (c === "[") {
      const m = /^\[\s*'([^']*)'\s*\/\s*'([^']*)'\s*\]/.exec(src.slice(i));
      if (!m) return null;
      toks.push({ t: "ref", ds: m[1]!, col: m[2]! });
      i += m[0].length;
      continue;
    }
    if (c === "'") {
      let v = "";
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        v += src[i]!;
        i++;
      }
      if (!closed) return null;
      toks.push({ t: "str", v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: "word", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "<>" || two === "!=" || two === "||") {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("=><+-*/%".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    if ("()".includes(c)) { toks.push({ t: "punct", v: c }); i++; continue; }
    if ("[".includes(c)) return null; // 已在上面处理,到这里说明 ref 格式非法
    return null; // 其余字符(含分号等)一律拒绝
  }
  return toks;
}

class FilterParser {
  private pos = 0;
  constructor(private readonly toks: FTok[], private readonly ctx: CompileCtx) {}

  private peek(): FTok | undefined {
    return this.toks[this.pos];
  }

  parse(): Result<string> {
    const r = this.parseOr();
    if (!r.ok) return r;
    if (this.pos !== this.toks.length) return err("DSL_PARSE", "过滤器存在多余 token");
    return r;
  }

  private parseOr(): Result<string> {
    const left = this.parseAnd();
    if (!left.ok) return left;
    const parts = [left.value];
    for (;;) {
      const t = this.peek();
      if (t?.t === "word" && t.v.toUpperCase() === "OR") {
        this.pos++;
        const r = this.parseAnd();
        if (!r.ok) return r;
        parts.push(r.value);
      } else break;
    }
    return ok(parts.length === 1 ? parts[0]! : parts.join(" OR "));
  }

  private parseAnd(): Result<string> {
    const left = this.parseComparison();
    if (!left.ok) return left;
    const parts = [left.value];
    for (;;) {
      const t = this.peek();
      if (t?.t === "word" && t.v.toUpperCase() === "AND") {
        this.pos++;
        const r = this.parseComparison();
        if (!r.ok) return r;
        parts.push(r.value);
      } else break;
    }
    return ok(parts.length === 1 ? parts[0]! : parts.join(" AND "));
  }

  /** primary:NOT / 括号组 / 操作数;比较运算符由 parseComparison 在其后判断 */
  private parsePrimary(): Result<string> {
    const t = this.peek();
    if (t?.t === "word" && t.v.toUpperCase() === "NOT") {
      this.pos++;
      const r = this.parsePrimary();
      if (!r.ok) return r;
      return ok(`NOT ${r.value}`);
    }
    if (t?.t === "punct" && t.v === "(") {
      this.pos++;
      const inner = this.parseOr();
      if (!inner.ok) return inner;
      const close = this.peek();
      if (close?.t !== "punct" || close.v !== ")") return err("DSL_PARSE", "括号不匹配");
      this.pos++;
      if (isSingleGroup(inner.value)) return inner;
      return ok(`(${inner.value})`);
    }
    return this.parseOperand();
  }

  private parseComparison(): Result<string> {
    const left = this.parsePrimary();
    if (!left.ok) return left;
    const op = this.peek();
    if (op?.t === "op" && SQL_BINOPS.has(op.v)) {
      this.pos++;
      const right = this.parseOperand();
      if (!right.ok) return right;
      return ok(`(${left.value} ${op.v} ${right.value})`);
    }
    // 无比较运算符:布尔引用
    return left;
  }

  /** 操作数:原子(引用/字面量)或单层括号包裹的原子;不允许子表达式(严格,fail-closed) */
  private parseOperand(): Result<string> {
    const t = this.peek();
    if (!t) return err("DSL_PARSE", "过滤器意外结束");
    let wrapped = false;
    if (t.t === "punct" && t.v === "(") {
      wrapped = true;
      this.pos++;
    }
    const cur = this.peek();
    if (!cur) return err("DSL_PARSE", "过滤器意外结束");
    let atom: string;
    if (cur.t === "ref") {
      this.pos++;
      const col = this.ctx.resolveColumn(cur.ds, cur.col);
      if (col === null) return err("UNRESOLVED_REF", `数据集列未在血缘映射中:${cur.ds}.${cur.col}`);
      if (!isQualifiedIdent(col)) return err("DSL_IDENT", `列名不合法:${col}`);
      atom = col;
    } else if (cur.t === "num") { this.pos++; atom = cur.v; }
    else if (cur.t === "str") { this.pos++; atom = quoteLiteral(cur.v); }
    else if (cur.t === "word") {
      const up = cur.v.toUpperCase();
      if (up === "NULL" || up === "TRUE" || up === "FALSE") { this.pos++; atom = up; }
      else return err("DSL_PARSE", `意外的标识符:${cur.v}`);
    } else {
      return err("DSL_PARSE", `意外的 token:${JSON.stringify(cur)}`);
    }
    if (wrapped) {
      const close = this.peek();
      if (close?.t !== "punct" || close.v !== ")") return err("DSL_PARSE", "操作数括号内必须是原子(不支持子表达式)");
      this.pos++;
      return ok(`(${atom})`);
    }
    return ok(atom);
  }
}

/** s 是否是单一平衡括号组(首尾括号互相匹配),用于安全去重 */
function isSingleGroup(s: string): boolean {
  if (!(s.startsWith("(") && s.endsWith(")"))) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0 && i < s.length - 1) return false; // 提前闭合 → 不是单一组
    }
  }
  return depth === 0;
}

export function compileFilterExpr(src: string, ctx: CompileCtx): Result<string> {
  const text = (src ?? "").trim();
  if (!text) return err("DSL_PARSE", "空过滤器");
  const toks = lexFilter(text);
  if (toks === null) return err("DSL_PARSE", "过滤器词法分析失败(含非法字符)");
  if (toks.length === 0) return err("DSL_PARSE", "空过滤器");
  return new FilterParser(toks, ctx).parse();
}

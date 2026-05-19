import type { FleetTemplate } from "@ogamex/shared";

export interface TemplatePickStats {
  black_hole_rate_24h: number;
  loss_rate_24h: number;
  avg_yield_24h: number;
}

export interface TemplatePickContext {
  templates: Record<string, FleetTemplate>;
  stats: TemplatePickStats;
}

export interface TemplatePickResult {
  id: string;
  template: FleetTemplate;
}

type Token = string;

const KNOWN_IDENTS: readonly (keyof TemplatePickStats)[] = [
  "black_hole_rate_24h",
  "loss_rate_24h",
  "avg_yield_24h",
];

function tokenize(src: string): Token[] {
  const re = /\s*(>=|<=|==|!=|&&|\|\||[<>()]|[a-zA-Z_][a-zA-Z0-9_]*|-?\d+(?:\.\d+)?)/g;
  const tokens: Token[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== pos && src.slice(pos, m.index).trim() !== "") {
      throw new Error(`parse error: unexpected char at ${pos}`);
    }
    const tok = m[1];
    if (tok === undefined) throw new Error("parse error: empty token");
    tokens.push(tok);
    pos = re.lastIndex;
  }
  if (src.slice(pos).trim() !== "") {
    throw new Error(`parse error: trailing input "${src.slice(pos)}"`);
  }
  return tokens;
}

class Parser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly stats: TemplatePickStats,
  ) {}

  parse(): boolean {
    const v = this.parseOr();
    if (this.i !== this.tokens.length) {
      throw new Error(`parse error: extra tokens after expression`);
    }
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private consume(): Token {
    const t = this.tokens[this.i];
    if (t === undefined) throw new Error("parse error: unexpected end of input");
    this.i++;
    return t;
  }

  private parseOr(): boolean {
    let v = this.parseAnd();
    while (this.peek() === "||") {
      this.consume();
      const r = this.parseAnd();
      v = v || r;
    }
    return v;
  }

  private parseAnd(): boolean {
    let v = this.parseAtom();
    while (this.peek() === "&&") {
      this.consume();
      const r = this.parseAtom();
      v = v && r;
    }
    return v;
  }

  private parseAtom(): boolean {
    const t = this.peek();
    if (t === undefined) throw new Error("parse error: unexpected end of input");
    if (t === "(") {
      this.consume();
      const v = this.parseOr();
      if (this.peek() !== ")") throw new Error("parse error: expected )");
      this.consume();
      return v;
    }
    if (t === "default") {
      this.consume();
      return true;
    }
    return this.parseComparison();
  }

  private parseComparison(): boolean {
    const ident = this.consume();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
      throw new Error(`parse error: expected identifier, got "${ident}"`);
    }
    if (!(KNOWN_IDENTS as readonly string[]).includes(ident)) {
      throw new Error(`unknown identifier: ${ident}`);
    }
    const op = this.consume();
    if (!["<", "<=", ">", ">=", "==", "!="].includes(op)) {
      throw new Error(`parse error: expected comparison operator, got "${op}"`);
    }
    const numTok = this.consume();
    if (!/^-?\d+(?:\.\d+)?$/.test(numTok)) {
      throw new Error(`parse error: expected number, got "${numTok}"`);
    }
    const lhs = this.stats[ident as keyof TemplatePickStats];
    const rhs = Number(numTok);
    switch (op) {
      case "<":
        return lhs < rhs;
      case "<=":
        return lhs <= rhs;
      case ">":
        return lhs > rhs;
      case ">=":
        return lhs >= rhs;
      case "==":
        return lhs === rhs;
      case "!=":
        return lhs !== rhs;
      default:
        throw new Error(`parse error: unknown op "${op}"`);
    }
  }
}

export function evalUsedWhen(expr: string, stats: TemplatePickStats): boolean {
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new Error("parse error: empty expression");
  return new Parser(tokens, stats).parse();
}

export function pickTemplate(ctx: TemplatePickContext): TemplatePickResult {
  for (const [id, template] of Object.entries(ctx.templates)) {
    if (evalUsedWhen(template.used_when, ctx.stats)) {
      return { id, template };
    }
  }
  for (const [id, template] of Object.entries(ctx.templates)) {
    if (template.used_when === "default") {
      return { id, template };
    }
  }
  throw new Error("no matching template + no default");
}

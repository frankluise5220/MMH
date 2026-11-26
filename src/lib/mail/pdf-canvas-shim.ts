/**
 * pdf-parse 2.x 走 pdfjs，pdfjs 在给**图片蒙版**（银行流水的水印、印章）描边时会
 * `new DOMMatrix().scaleSelf(...).translateSelf(...)`。这条路径在 `getOperatorList`
 * 内部，也就是 `getText()` / `getTable()` 都会走到，不是「只有渲染才需要」。
 *
 * 原生 canvas 包不可用时 pdfjs 只打印一句
 * `Cannot polyfill DOMMatrix, rendering may be broken` 的警告，随后在这条路径上抛
 * `DOMMatrix is not defined`，整个 PDF 附件解析失败：上层只能报「这个 PDF 解析失败，
 * 文件可能已损坏」，连加密 PDF 的密码框都弹不出来。
 *
 * 为什么不在镜像里装 `@napi-rs/canvas`：它的平台包（canvas-linux-x64-gnu）解压
 * 31MB（skia.node + icudtl.dat），压缩后仍是 10MB 级别的一层，会顶爆 Docker 更新
 * 的单层体积预算；而 pdfjs 在这条路径上只需要一个 2D 矩阵。所以在 JS 侧补一个够用的
 * 实现，所有渠道（Docker / fnOS / SPK / 桌面）一次覆盖。
 */

type MatrixLike = {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
};

class DomMatrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | MatrixLike | DomMatrix2D) {
    if (Array.isArray(init)) {
      const [a, b, c, d, e, f] = init;
      this.set(a, b, c, d, e, f);
    } else if (init) {
      this.set(init.a, init.b, init.c, init.d, init.e, init.f);
    }
  }

  private set(a?: number, b?: number, c?: number, d?: number, e?: number, f?: number) {
    if (Number.isFinite(a)) this.a = a as number;
    if (Number.isFinite(b)) this.b = b as number;
    if (Number.isFinite(c)) this.c = c as number;
    if (Number.isFinite(d)) this.d = d as number;
    if (Number.isFinite(e)) this.e = e as number;
    if (Number.isFinite(f)) this.f = f as number;
  }

  get is2D() {
    return true;
  }

  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(other: MatrixLike) {
    const { a: a2 = 1, b: b2 = 0, c: c2 = 0, d: d2 = 1, e: e2 = 0, f: f2 = 0 } = other;
    const { a, b, c, d, e, f } = this;
    this.a = a * a2 + c * b2;
    this.b = b * a2 + d * b2;
    this.c = a * c2 + c * d2;
    this.d = b * c2 + d * d2;
    this.e = a * e2 + c * f2 + e;
    this.f = b * e2 + d * f2 + f;
    return this;
  }

  preMultiplySelf(other: MatrixLike) {
    const { a = 1, b = 0, c = 0, d = 1, e = 0, f = 0 } = other;
    const { a: a2, b: b2, c: c2, d: d2, e: e2, f: f2 } = this;
    this.a = a * a2 + c * b2;
    this.b = b * a2 + d * b2;
    this.c = a * c2 + c * d2;
    this.d = b * c2 + d * d2;
    this.e = a * e2 + c * f2 + e;
    this.f = b * e2 + d * f2 + f;
    return this;
  }

  translateSelf(tx = 0, ty = 0) {
    this.e += this.a * tx + this.c * ty;
    this.f += this.b * tx + this.d * ty;
    return this;
  }

  scaleSelf(sx: number, sy = sx) {
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
    return this;
  }

  rotateSelf(degrees = 0) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return this.multiplySelf({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
  }

  inverse() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) return new DomMatrix2D();
    const ia = d / det;
    const ib = -b / det;
    const ic = -c / det;
    const id = a / det;
    return new DomMatrix2D([ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)]);
  }

  invertSelf() {
    const inverted = this.inverse();
    this.set(inverted.a, inverted.b, inverted.c, inverted.d, inverted.e, inverted.f);
    return this;
  }

  transformPoint(point: { x?: number; y?: number } = {}) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }

  toFloat32Array() {
    return new Float32Array([this.a, this.b, this.c, this.d, this.e, this.f, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  }

  toFloat64Array() {
    return new Float64Array(this.toFloat32Array());
  }

  toString() {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

/** pdfjs 会去取 `globalThis.DOMMatrix`；已有原生实现（装了 @napi-rs/canvas）时不要覆盖。 */
export function installPdfCanvasShim() {
  const scope = globalThis as Record<string, unknown>;
  if (typeof scope.DOMMatrix !== "function") scope.DOMMatrix = DomMatrix2D;
}

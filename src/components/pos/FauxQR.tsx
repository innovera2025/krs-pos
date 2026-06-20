/**
 * Deterministic faux QR (display-faux-qr). NOT a scannable code — a stylized
 * placeholder for the digital-receipt link, ported from the Simple POS source.
 * The cell pattern is a pure function of position (no `value` needed) so it
 * renders identically every time; finder-corner squares mimic a real QR.
 */
export function FauxQR({ size = 104 }: { size?: number }) {
  const N = 11;
  const seed = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
  const on = (r: number, c: number): boolean => {
    // Finder corners (top-left, top-right, bottom-left).
    if ((r < 3 && c < 3) || (r < 3 && c > N - 4) || (r > N - 4 && c < 3)) {
      return r === 0 || r === 2 || c === 0 || c === 2 || (r === 1 && c === 1);
    }
    return (r * 7 + c * 13 + seed[(r + c) % seed.length]) % 3 === 0;
  };

  const cells: { x: number; y: number }[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (on(r, c)) cells.push({ x: c * 9 + 2, y: r * 9 + 2 });
    }
  }

  return (
    <svg
      viewBox="0 0 103 103"
      width={size}
      height={size}
      role="img"
      aria-label="QR ใบเสร็จดิจิทัล"
    >
      {cells.map((cell, i) => (
        <rect key={i} x={cell.x} y={cell.y} width="9" height="9" fill="#0f172a" />
      ))}
    </svg>
  );
}

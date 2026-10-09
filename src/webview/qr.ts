import qrcode from 'qrcode-generator';

/** QR-код строки: размер матрицы и путь SVG из единичных квадратов (без внешнего HTML). */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  }
  return { size, d };
}

#!/usr/bin/env python3
"""生成 Tauri 所需的最小有效图标文件（仅在图标缺失或无效时生成）"""
import struct, zlib, os, sys

def make_png(path, w=1, h=1):
    """生成最小有效 PNG 文件"""
    raw = b'\x00' * (w * 4 * h + h)  # RGBA + filter byte per row
    compressed = zlib.compress(raw)
    def chunk(ctype, data):
        raw_chunk = ctype + data
        return struct.pack('>I', len(data)) + raw_chunk + struct.pack('>I', zlib.crc32(raw_chunk) & 0xffffffff)
    ihdr_data = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr_data) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

def ensure_icon(path, gen_func):
    """仅在图标缺失或过小时生成"""
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return
    gen_func(path)
    print(f"  生成: {path}")

if __name__ == '__main__':
    icons_dir = sys.argv[1] if len(sys.argv) > 1 else 'icons'
    os.makedirs(icons_dir, exist_ok=True)

    print("检查图标文件...")
    ensure_icon(os.path.join(icons_dir, '32x32.png'), lambda p: make_png(p, 32, 32))
    ensure_icon(os.path.join(icons_dir, '128x128.png'), lambda p: make_png(p, 128, 128))
    ensure_icon(os.path.join(icons_dir, '128x128@2x.png'), lambda p: make_png(p, 256, 256))
    # icns 和 ico 用最小占位
    ensure_icon(os.path.join(icons_dir, 'icon.icns'), lambda p: open(p, 'wb').write(b'\x00' * 8))
    ensure_icon(os.path.join(icons_dir, 'icon.ico'), lambda p: open(p, 'wb').write(b'\x00' * 8))
    print("图标检查完成")

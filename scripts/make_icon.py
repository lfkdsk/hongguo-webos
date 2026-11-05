"""Generate the simple launcher icon using only Python's standard library."""

import struct
import zlib
from pathlib import Path


size = 130
pixels = bytearray()
for y in range(size):
    pixels.append(0)
    for x in range(size):
        rounded = not ((x < 17 and y < 17 and (x - 17) ** 2 + (y - 17) ** 2 > 17 ** 2)
                       or (x > 112 and y < 17 and (x - 112) ** 2 + (y - 17) ** 2 > 17 ** 2)
                       or (x < 17 and y > 112 and (x - 17) ** 2 + (y - 112) ** 2 > 17 ** 2)
                       or (x > 112 and y > 112 and (x - 112) ** 2 + (y - 112) ** 2 > 17 ** 2))
        play = 38 <= x <= 96 and 34 <= y <= 96 and x >= 38 + abs(y - 65) * 0.35 and x <= 98 - abs(y - 65) * 0.9
        pixels.extend((255, 246, 235, 255) if play else (222, 57, 58, 255) if rounded else (0, 0, 0, 0))


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(pixels), 9))
png += chunk(b'IEND', b'')
Path(__file__).resolve().parents[1].joinpath('app/icon.png').write_bytes(png)


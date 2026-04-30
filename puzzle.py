import random
import sys
import tty
import termios

def create_board():
    tiles = list(range(1, 16)) + [0]
    while True:
        random.shuffle(tiles)
        if is_solvable(tiles) and tiles != list(range(1, 16)) + [0]:
            return tiles

def is_solvable(tiles):
    inversions = 0
    flat = [t for t in tiles if t != 0]
    for i in range(len(flat)):
        for j in range(i + 1, len(flat)):
            if flat[i] > flat[j]:
                inversions += 1
    blank_row = tiles.index(0) // 4
    return (inversions + blank_row) % 2 == 0

def draw(tiles, moves):
    print("\033[H\033[J", end="")  # 画面クリア
    print("┌─────────────────┐")
    for row in range(4):
        print("│", end="")
        for col in range(4):
            t = tiles[row * 4 + col]
            if t == 0:
                print("    ", end="")
            else:
                print(f" {t:2d} ", end="")
        print("│")
    print("└─────────────────┘")
    print(f"  手数: {moves}")
    print("  操作: W/A/S/D または ↑←↓→   Q で終了")

def get_key():
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        if ch == '\x1b':
            ch2 = sys.stdin.read(1)
            ch3 = sys.stdin.read(1)
            return ch + ch2 + ch3
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)

def move(tiles, key):
    blank = tiles.index(0)
    r, c = divmod(blank, 4)

    # 空白を動かす方向（キーは「タイルを動かす方向」）
    dirs = {
        's': (-1, 0), 'S': (-1, 0), '\x1b[A': (-1, 0),  # 上のタイルを下へ
        'w': (1, 0),  'W': (1, 0),  '\x1b[B': (1, 0),   # 下のタイルを上へ
        'd': (0, -1), 'D': (0, -1), '\x1b[D': (0, -1),  # 左のタイルを右へ
        'a': (0, 1),  'A': (0, 1),  '\x1b[C': (0, 1),   # 右のタイルを左へ
    }

    if key not in dirs:
        return False

    dr, dc = dirs[key]
    nr, nc = r + dr, c + dc
    if 0 <= nr < 4 and 0 <= nc < 4:
        target = nr * 4 + nc
        tiles[blank], tiles[target] = tiles[target], tiles[blank]
        return True
    return False

def is_solved(tiles):
    return tiles == list(range(1, 16)) + [0]

def main():
    tiles = create_board()
    moves = 0

    draw(tiles, moves)

    while True:
        key = get_key()

        if key in ('q', 'Q', '\x03'):
            print("\n終了します。")
            break

        if move(tiles, key):
            moves += 1
            draw(tiles, moves)

            if is_solved(tiles):
                print(f"\n  おめでとう！ {moves} 手でクリア！ 🎉\n")
                break

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Drive the staged e2e scene through uinput, so takeone's evdev taps see real
kernel input events (a click here is a real BTN_LEFT, a keystroke a real key).

    drive.py serve FIFO     create the devices, then run commands read from FIFO
    echo 'scene' > FIFO     run the ~60 s choreography against scripts/e2e/scene.html

Commands: move X Y [MS] | click X Y | down | up | type TEXT | key NAME |
scroll N | sleep MS | scene | quit. Coordinates are logical layout pixels.
Needs write access to /dev/uinput (group 'input'). Only ever types the fixed
dummy text below.
"""

import fcntl, math, os, random, struct, sys, time

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
REL_WHEEL, REL_WHEEL_HI_RES = 8, 11
ABS_X, ABS_Y = 0, 1
BTN_LEFT, BTN_RIGHT = 0x110, 0x111
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045566, 0x40045567
UI_DEV_SETUP, UI_ABS_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x405C5503, 0x401C5504, 0x5501, 0x5502
BUS_VIRTUAL = 0x06
ABS_MAX = 65535

LAYOUT_W, LAYOUT_H = 2560, 1440  # logical size of the single output

KEYS = {c: k for k, c in zip(
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 36, 37, 38, 44, 45, 46, 47, 48, 49, 50],
    "qwertyuiopasdfghjklzxcvbnm")}
KEYS.update({" ": 57, ".": 52, ",": 51, "-": 12})
NAMED = {"enter": 28, "backspace": 14, "tab": 15, "esc": 1, "shift": 42}


def device(name, evbits, keybits=(), relbits=(), abs_axes=()):
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    for ev in evbits:
        fcntl.ioctl(fd, UI_SET_EVBIT, ev)
    for k in keybits:
        fcntl.ioctl(fd, UI_SET_KEYBIT, k)
    for r in relbits:
        fcntl.ioctl(fd, UI_SET_RELBIT, r)
    for a in abs_axes:
        fcntl.ioctl(fd, UI_SET_ABSBIT, a)
        # struct uinput_abs_setup { __u16 code; struct input_absinfo { value, min, max, fuzz, flat, res } }
        fcntl.ioctl(fd, UI_ABS_SETUP, struct.pack("<HxxIiiiii", a, 0, 0, ABS_MAX, 0, 0, 0))
    fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack("<HHHH80sI", BUS_VIRTUAL, 0x7461, 0x0001, 1, name.encode(), 0))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    return fd


def emit(fd, events):
    now = time.time()
    sec, usec = int(now), int((now % 1) * 1e6)
    buf = b"".join(struct.pack("<qqHHi", sec, usec, t, c, v) for t, c, v in events)
    os.write(fd, buf + struct.pack("<qqHHi", sec, usec, EV_SYN, 0, 0))


class Driver:
    def __init__(self):
        self.ptr = device("takeone-e2e pointer", [EV_KEY, EV_REL, EV_ABS], [BTN_LEFT, BTN_RIGHT],
                          [REL_WHEEL, REL_WHEEL_HI_RES], [ABS_X, ABS_Y])
        self.kbd = device("takeone-e2e keyboard", [EV_KEY], list(KEYS.values()) + list(NAMED.values()))
        self.x, self.y = LAYOUT_W / 2, LAYOUT_H / 2
        self.rng = random.Random(7)
        time.sleep(1.0)  # let libinput pick the devices up

    def warp(self, x, y):
        self.x, self.y = x, y
        ax = round(x / (LAYOUT_W - 1) * ABS_MAX)
        ay = round(y / (LAYOUT_H - 1) * ABS_MAX)
        emit(self.ptr, [(EV_ABS, ABS_X, ax), (EV_ABS, ABS_Y, ay)])

    def move(self, x, y, ms=None):
        """Human-ish move: eased, slightly curved, duration from distance."""
        x0, y0 = self.x, self.y
        dist = math.hypot(x - x0, y - y0)
        if ms is None:
            ms = 250 + 120 * math.log2(1 + dist / 40)
        steps = max(2, int(ms / 8))
        bow = self.rng.uniform(-0.08, 0.08) * dist
        nx, ny = (-(y - y0) / dist, (x - x0) / dist) if dist else (0, 0)
        for i in range(1, steps + 1):
            u = i / steps
            e = u * u * (3 - 2 * u)
            b = math.sin(math.pi * u) * bow
            self.warp(x0 + (x - x0) * e + nx * b, y0 + (y - y0) * e + ny * b)
            time.sleep(ms / 1000 / steps)
        self.warp(x, y)

    def button(self, down):
        emit(self.ptr, [(EV_KEY, BTN_LEFT, 1 if down else 0)])

    def click(self, x, y):
        self.move(x, y)
        time.sleep(0.12)
        self.button(True)
        time.sleep(0.08)
        self.button(False)

    def key(self, code, shift=False):
        if shift:
            emit(self.kbd, [(EV_KEY, NAMED["shift"], 1)])
        emit(self.kbd, [(EV_KEY, code, 1)])
        time.sleep(0.03)
        emit(self.kbd, [(EV_KEY, code, 0)])
        if shift:
            emit(self.kbd, [(EV_KEY, NAMED["shift"], 0)])

    def type(self, text):
        for ch in text:
            self.key(KEYS[ch.lower()], shift=ch.isupper())
            time.sleep(self.rng.uniform(0.05, 0.14) + (0.12 if ch == " " else 0))

    def scroll(self, n):
        step = 1 if n > 0 else -1
        for _ in range(abs(n)):
            # Wheel down is a negative REL_WHEEL value.
            emit(self.ptr, [(EV_REL, REL_WHEEL, -step), (EV_REL, REL_WHEEL_HI_RES, -120 * step)])
            time.sleep(0.16)

    def drag(self, x0, y0, x1, y1, ms):
        self.move(x0, y0)
        time.sleep(0.15)
        self.button(True)
        time.sleep(0.12)
        self.move(x0 + 12, y0 + 6, 120)
        self.move(x1, y1, ms)
        time.sleep(0.2)
        self.button(False)

    def scene(self):
        """~60 s of realistic work in scripts/e2e/scene.html (2560x1440 geometry)."""
        s = time.sleep
        self.warp(1500, 900)
        s(2.5)
        self.move(1200, 700); s(0.8)                     # look around
        self.click(2300, 44); s(1.2)                     # + New task -> modal
        self.type("Draft launch announcement"); s(0.8)   # title field is focused
        self.click(1280, 650); s(0.4)                    # notes
        self.type("Two short paragraphs and a link to the demo."); s(1.0)
        self.click(1094, 799); s(0.9)                    # priority dropdown
        self.move(1094, 975); s(0.5)
        self.click(1094, 975); s(0.9)                    # High
        self.click(1530, 908); s(2.4)                    # Create task -> card + toast
        self.drag(560, 250, 1110, 300, 1500); s(2.0)     # new card: To do -> In progress
        self.move(2250, 640); s(0.6)                     # activity feed
        self.scroll(7); s(1.2)
        self.scroll(-3); s(1.5)
        for dx, dy in ((6, 3), (-4, 5), (3, -6), (-5, -2), (4, 4)):   # small hand tremor
            self.move(self.x + dx, self.y + dy, 90); s(0.25)
        s(0.8)
        self.click(1080, 414); s(1.6)                    # mark "Beta feedback survey" done
        self.click(2475, 44); s(1.0)                     # overflow menu
        self.move(2350, 166); s(0.5)
        self.click(2350, 166); s(2.6)                    # Archive done tasks
        self.move(1300, 760, 900); s(1.5)
        self.click(2300, 44); s(1.0)                     # second, quick task
        self.type("Book demo room"); s(0.6)
        self.click(1530, 908); s(3.0)
        self.move(1600, 1000, 800); s(3.0)               # closing hold

    def close(self):
        for fd in (self.ptr, self.kbd):
            fcntl.ioctl(fd, UI_DEV_DESTROY)
            os.close(fd)


def run(d, line):
    cmd, *a = line.split(" ", 1)
    arg = a[0] if a else ""
    nums = [float(v) for v in arg.split()] if cmd in ("move", "click", "scroll", "sleep") else []
    if cmd == "move":
        d.move(*nums)
    elif cmd == "click":
        d.click(*nums)
    elif cmd == "down":
        d.button(True)
    elif cmd == "up":
        d.button(False)
    elif cmd == "type":
        d.type(arg)
    elif cmd == "key":
        d.key(NAMED[arg])
    elif cmd == "scroll":
        d.scroll(int(nums[0]))
    elif cmd == "sleep":
        time.sleep(nums[0] / 1000)
    elif cmd == "scene":
        d.scene()
    elif cmd == "quit":
        return False
    else:
        print(f"unknown command: {line}", file=sys.stderr)
    return True


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "serve":
        sys.exit(__doc__)
    fifo = sys.argv[2]
    if not os.path.exists(fifo):
        os.mkfifo(fifo, 0o600)
    d = Driver()
    print("ready", flush=True)
    try:
        going = True
        while going:
            with open(fifo) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        going = run(d, line)
                        print(f"done {line.split(' ', 1)[0]}", flush=True)
                        if not going:
                            break
    finally:
        d.close()


if __name__ == "__main__":
    main()

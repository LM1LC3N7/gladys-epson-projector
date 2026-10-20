# Third-party notices

This integration ports to JavaScript the logic of the following project: the
ESC/VP.net messages (the 16-byte header, the 18-byte headers, the HELLO and
CONNECT requests, the status codes, the password header), the ESC/VP21
session over TCP 3629 (questions `COMMAND?`, answers read up to `:`, `ERR`,
the pushed `IMEVENT` messages skipped), the commands used (`PWR`, `SOURCE`,
`CMODE`, `MUTE`, `LAMP`, `SNO`), the source and color mode codes and their
labels, and the waits of the power commands (`src/escvp/`). Only its
ESC/VP.net transport is ported, not its HTTP mode. Nothing of it is installed
at runtime; its notice is reproduced below.

## epson-projector 0.6.0

<https://github.com/pszafer/epson_projector> by Paweł Szafer (the library
behind the Home Assistant Epson integration), version 0.6.0 (PyPI, 2025-10-16),
repository read at commit `85871d5` of 2026-06-23. Its LICENSE file is the
MIT text with the copyright line of a packaging template, reproduced as is:

```
Copyright (c) 2018 The Python Packaging Authority

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Epson ESC/VP21 and ESC/VP.net documentation

The ESC/VP21 command guide and the ESC/VP.net specification published by
Epson were used as facts (power state codes, message layout). No text of them
is reproduced.

## LM1LC3N7/gladys-panasonic-viera and LM1LC3N7/gladys-cambridge-audio

The structure of the app, the `/data` store, the command queue and budget,
and the handler wiring follow integrations of the same author, under the
Apache License 2.0 of this repository.

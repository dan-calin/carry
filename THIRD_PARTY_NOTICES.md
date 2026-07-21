# Third-party notices

Carry is MIT-licensed. Windows builds also contain the following unmodified
third-party components:

## Node.js

The official Windows x64 Node.js runtime is bundled under the licenses shipped
with that distribution. Its complete license text is installed as
`runtime/LICENSE-node.txt`.

## node-datachannel 0.32.3

Carry uses the unmodified `node-datachannel` binding and its bundled
`libdatachannel` implementation to provide WebRTC DataChannels. The package is
licensed under the Mozilla Public License 2.0. Its source is available at:

https://github.com/murat-dogan/node-datachannel/tree/v0.32.3

The complete MPL-2.0 license is included with the installed package at
`node_modules/node-datachannel/LICENSE`.

## Tauri 2

Carry's native desktop shell uses Tauri and its Rust dependencies under their
respective open-source licenses. The dependency versions and checksums are
locked in `src-tauri/Cargo.lock`; source and license information is available
from https://github.com/tauri-apps/tauri.

## Microsoft Edge WebView2 Runtime

Carry uses the separately serviced Microsoft Edge WebView2 Runtime as its
Windows web platform. The signed Evergreen bootstrapper is bundled only so
Carry can install that runtime when Windows does not already provide it.
Microsoft's terms are available at:

https://www.microsoft.com/software-download/webview2

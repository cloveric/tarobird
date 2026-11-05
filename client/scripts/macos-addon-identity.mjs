import { execFileSync } from 'node:child_process';

// Rust's cdylib default install name is its absolute build path. Normalize the
// copied addon before code signing; source-path remapping does not cover this
// Mach-O load command.
export function normalizeMacAddonIdentity(addon) {
  execFileSync('/usr/bin/install_name_tool', ['-id', '@rpath/tarobot-desktop-native.node', addon], { stdio: 'pipe' });
  const output = execFileSync('/usr/bin/otool', ['-D', addon], { encoding: 'utf8' });
  if (output.trim().split('\n').at(-1) !== '@rpath/tarobot-desktop-native.node') {
    throw new Error('Mac addon install name was not normalized');
  }
}

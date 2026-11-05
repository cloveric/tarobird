import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appCapabilityInstructions, appTurnInstructions, workbenchInstructions } from '../src/gateway/agent-instructions.js';
import { workbenchDesignGuidance } from '../src/gateway/design-guidance.js';

const engines = ['codex', 'claude', 'kimi', 'deepseek', 'antigravity'] as const;
const checkSelection = (text: string | undefined) => {
  expect(text).toContain('用 Design 做 PPT');
  expect(text).toContain("engine's native presentation skill");
  expect(text).toContain('Design alone');
  expect(text).toContain('baoyu-ppt');
  expect(text).toContain('宝育 PPT');
  expect(text).toContain('unambiguous continuation');
  expect(text).toContain('Explicit native/no-Baoyu');
};

describe('presentation routing does not infer Baoyu from bare Design or a selected canvas', () => {
  it.each([
    '用 Design 做 PPT。', 'Use Design to make a PowerPoint presentation.',
    '做一份幻灯片。', '修改 quarterly.pptx。', '用 Design 做个演示。',
    '做个汇报材料。', 'Make a keynote.', '請做一份簡報。', '請做一份投影片。',
  ])('sends the selection rule for %s through every engine turn', input => {
    for (const engine of engines) {
      const text = appTurnInstructions(input, { engine, nativeDelivery: true, nativeWidgets: true });
      checkSelection(text);
      // This is guidance for model selection, not an automatic opening command.
      expect(text).not.toContain("operation:'design.open'");
    }
  });
  it.each(['用 Design 画张海报。', 'Refactor the design system.'])('keeps PPT selection hints out of non-presentation turns: %s', input => {
    expect(appTurnInstructions(input, { nativeDelivery: true, nativeWidgets: true }) ?? '').not.toContain('PPT selection:');
  });
  it.each(engines)('%s keeps the rule in closed and selected Design contexts, including resumed old tools', engine => {
    const opener = { deviceId: 'd', windowId: 'opener' };
    for (const context of [
      { target: opener, openTarget: opener },
      { target: { deviceId: 'd', windowId: 'controller', tabId: 'design' }, kind: 'design', revision: 1 },
    ]) checkSelection(workbenchInstructions('chat', 'input', context, undefined, { engine }));
  });
  it.each(['browser', 'widgets'] as const)('%s capability returns the same explicit selection boundary', topic => {
    checkSelection(appCapabilityInstructions(topic, { widgetsEnabled: true }));
  });
  it.each(['baoyu-design', 'baoyu-ppt'])('%s skill metadata cannot capture bare Design + PPT requests', name => {
    const text = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    expect(text.split('---')[1]).toContain('Design alone');
    expect(text).toContain('用 Design 做 PPT');
    expect(text).toContain('native presentation skill');
  });
});

describe('Workbench is a PPT destination, not an authoring skill selection', () => {
  it.each(['做一个今天天气的ppt，放工作台', 'Use your native presentation skill and put the deck in Workbench.'])('keeps native authoring and neutral choices for %s', input => {
    const guide = appTurnInstructions(input, { engine: 'claude', nativeDelivery: true })!;
    expect(guide).toContain('Workbench is a destination, not a skill selection');
    expect(guide).toContain('Do not offer a Baoyu recommendation');
    expect(guide).toContain('not explicit user selection');
  });
  it('allows an explicitly requested Workbench PPT to open without selecting a branded skill', () => {
    const opener = { deviceId: 'd', windowId: 'opener' };
    const guide = workbenchInstructions('chat', 'input', { target: opener, openTarget: opener });
    expect(guide).toContain('explicit request to put a PPT in Workbench');
    expect(guide).toContain('does not select an authoring skill');
    expect(guide).not.toContain("format:'slides' for Baoyu PPT");
  });
  it('provides a native-authoring publication route with honest format limits', () => {
    expect(workbenchDesignGuidance).toContain('Native authoring to Workbench');
    expect(workbenchDesignGuidance).toContain('does not require loading baoyu-ppt');
    expect(workbenchDesignGuidance).toContain('not a binary PPTX importer');
    expect(workbenchDesignGuidance).not.toContain('Read the adapted baoyu-design or baoyu-ppt skill and current project first');
  });
});

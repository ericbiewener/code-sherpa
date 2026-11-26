import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'

let app: ElectronApplication
let page: Page
let directory: string
let env: Record<string, string>
const pageErrors: string[] = []

async function launch(feature = 'Basic Agent Session') {
  app = await _electron.launch({ args: [resolve('out/main/index.js')], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await expect(page.getByRole('heading', { name: 'PR Walkthrough' })).toBeVisible()
  if (feature !== 'PR Walkthrough') await navigate(feature)
}

async function navigate(feature: string) {
  await page.getByRole('button', { name: 'Navigation menu' }).click()
  await page
    .getByRole('navigation', { name: 'Features' })
    .getByRole('button', { name: feature, exact: true })
    .click()
  await expect(page.getByRole('heading', { name: feature, exact: true })).toBeVisible()
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sherpa-e2e-'))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  const fixture = resolve('tests/fixtures/agent.mjs')
  await chmod(fixture, 0o755)
  for (const name of ['codex', 'claude', 'pi', 'my-agent']) await symlink(fixture, join(bin, name))
  const shell = join(directory, 'test-shell')
  await writeFile(shell, '#!/bin/sh\nexec /usr/bin/env -0\n', { mode: 0o755 })
  env = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    SHELL: shell,
    SHERPA_DATA_DIR: join(directory, 'data'),
    SHERPA_CONFIG_FILE: join(directory, 'config.json'),
    SHERPA_FIXTURE_ARGV: join(directory, 'argv.json'),
    SHERPA_FIXTURE_ENV: join(directory, 'env.json'),
    SHERPA_FIXTURE_TRACE: join(directory, 'trace.jsonl'),
    SHERPA_FIXTURE_COMPLETE: join(directory, 'complete'),
  }
  await writeFile(
    env.SHERPA_CONFIG_FILE,
    JSON.stringify({
      version: 2,
      defaultProfileId: 'codex',
      profiles: ['codex', 'claude', 'pi'].map((harness) => ({
        id: harness,
        name: harness,
        options: {},
        harness,
      })),
    }),
  )
  pageErrors.length = 0
  await launch()
})

test.afterEach(async () => {
  await app?.close()
  await rm(directory, { recursive: true, force: true })
  expect(pageErrors).toEqual([])
})

async function createSession(command: string) {
  await page
    .getByRole('list', { name: 'Saved integrations' })
    .getByRole('button', { name: command, exact: true })
    .click()
  await expect(page.locator('.status-badge')).toHaveText('Ready')
}

async function addIntegration(harness: string, name = '', executable = '') {
  await page.getByRole('button', { name: 'Add integration' }).click()
  await page.getByLabel('Integration', { exact: true }).selectOption(harness)
  await page.getByLabel('Name', { exact: true }).fill(name)
  if (executable) {
    await page.getByText('Executable location', { exact: true }).click()
    await page.getByLabel('Executable path').fill(executable)
  }
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(page.getByLabel('Integration', { exact: true })).toHaveCount(0)
}

async function getState() {
  return page.evaluate(() => {
    if (!window.sherpa) throw new Error('Desktop API is unavailable')
    return window.sherpa.getState()
  })
}

async function send(text: string) {
  await page.getByLabel('Message your agent').fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

async function expectNativeResume(command: string, resumeId: string | undefined, count: number) {
  expect(resumeId).toBeTruthy()
  if (command === 'codex') {
    const trace = (await readFile(env.SHERPA_FIXTURE_TRACE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(trace.filter((record) => record.method === 'thread/resume')).toHaveLength(count)
    if (count)
      expect(trace).toContainEqual(
        expect.objectContaining({
          method: 'thread/resume',
          params: expect.objectContaining({ threadId: resumeId }),
        }),
      )
  } else if (command === 'claude' || count > 0) {
    const argv: string[] = JSON.parse(await readFile(env.SHERPA_FIXTURE_ARGV, 'utf8'))
    const flag = command === 'claude' ? '--resume' : '--session'
    const value =
      argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ??
      (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
    expect(value).toBe(resumeId)
  }
}

for (const [command, name] of [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['pi', 'Pi'],
]) {
  test(`PR walkthrough: sends the exact initial prompt through ${name} and resumes after navigation and restart`, async () => {
    await navigate('PR Walkthrough')
    const url = 'https://github.com/example/project/pull/42'
    const guidelines = await readFile(resolve('src/renderer/src/initial-prompt.md'), 'utf8')
    await expect(page.getByLabel('Agent settings', { exact: true })).toHaveValue('codex')
    await expect(page.getByRole('button', { name: 'Start walkthrough' })).toBeDisabled()
    await page.getByLabel('PR URL', { exact: true }).fill(url)
    await page.getByLabel('Agent settings', { exact: true }).selectOption(command)
    await page.screenshot({ path: `test-results/walkthrough-${command}.png` })
    await page.getByRole('button', { name: 'Start walkthrough' }).click()
    await expect(
      page.locator('.message.user').getByRole('heading', { name: 'Global guidelines' }),
    ).toBeVisible()
    await expect(page.locator('.message.user li code')).toHaveText('gh')
    await expect(page.locator('.message.user .message-content')).toContainText(
      `Fetch the full PR diff, title, and body for this URL: ${url}. Summarize the changeset.`,
    )
    await expect(page.locator('.message.assistant')).toContainText(`Hello from ${name}`)
    await expect(page.locator('.message.assistant .message-content strong')).toHaveText(name)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    const first = (await getState()).sessions[0]
    expect(first.harness).toBe(command)
    expect(first.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(first.messages.find((message) => message.role === 'user')?.text).toBe(
      `${guidelines.trimEnd()}\n\nFetch the full PR diff, title, and body for this URL: ${url}. Summarize the changeset.`,
    )
    await navigate('Basic Agent Session')
    await createSession('codex')
    await navigate('PR Walkthrough')
    let history = page.getByRole('list', { name: 'Saved walkthroughs' })
    await expect(history.getByRole('button')).toHaveCount(1)
    await history.getByRole('button').filter({ hasText: url }).click()
    await expect(page.locator('.message.assistant')).toHaveCount(1)
    await expect(page.locator('.message.user')).toHaveCount(1)
    await send('Explain the tests.')
    await expect(page.locator('.message.assistant')).toHaveCount(2)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    await expectNativeResume(command, first.resumeId, 0)
    expect((await getState()).sessions).toHaveLength(2)
    await page.getByRole('button', { name: 'Walkthroughs', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'PR Walkthrough' })).toBeVisible()
    await page
      .getByLabel('PR URL', { exact: true })
      .fill('https://github.com/example/project/pull/43')
    await page.getByRole('button', { name: 'Start walkthrough' }).click()
    await expect(page.locator('.message.user')).toHaveCount(1)
    await expect(page.locator('.message.user')).toContainText('/pull/43')
    const sessions = (await getState()).sessions
    expect(sessions).toHaveLength(3)
    expect(sessions[0].id).not.toBe(first.id)
    await app.close()
    await launch('PR Walkthrough')
    history = page.getByRole('list', { name: 'Saved walkthroughs' })
    await expect(history.getByRole('button')).toHaveCount(2)
    await page.screenshot({ path: `test-results/walkthrough-history-${command}.png` })
    await history.getByRole('button').filter({ hasText: url }).click()
    await expect(page.locator('.message.user')).toHaveCount(2)
    await expect(page.locator('.message.assistant')).toHaveCount(2)
    await send('Continue after restarting.')
    await expect(page.locator('.message.assistant')).toHaveCount(3)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    await expectNativeResume(command, first.resumeId, 1)
    const resumed = (await getState()).sessions
    expect(resumed).toHaveLength(3)
    expect(resumed.find((session) => session.id === first.id)).toMatchObject({
      prUrl: url,
      resumeId: first.resumeId,
    })
  })
}

test('walkthrough validates URLs, supports empty configs, and uses newly configured commands', async () => {
  await app.close()
  await rm(env.SHERPA_CONFIG_FILE)
  await launch('PR Walkthrough')
  await expect(page.getByText('Add an integration to start your first walkthrough.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start walkthrough' })).toBeDisabled()
  await page.getByRole('button', { name: 'Manage integrations' }).click()
  await addIntegration('pi', 'Work', 'my-agent')
  await navigate('PR Walkthrough')
  await expect(
    page.getByLabel('Agent settings', { exact: true }).locator('option:checked'),
  ).toHaveText('Work · Pi')
  await page.getByLabel('PR URL', { exact: true }).fill('not a url')
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  expect((await getState()).sessions).toHaveLength(0)
  await page.getByLabel('PR URL', { exact: true }).fill('file:///tmp/pr')
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP or HTTPS')
  expect((await getState()).sessions).toHaveLength(0)
  await page.getByLabel('PR URL', { exact: true }).fill('https://git.example.com/team/repo/pull/5')
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  await expect(page.locator('.message.assistant')).toContainText('Hello from Pi')
  expect(JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).profiles[0].harness).toBe('pi')
  await page.getByRole('button', { name: 'Walkthroughs', exact: true }).click()
  await expect(page.getByLabel('Agent type')).toHaveCount(0)
})

for (const command of ['codex', 'claude', 'pi']) {
  test(`${command}: navigation preserves active walkthroughs, drafts, and pending approvals`, async () => {
    await navigate('PR Walkthrough')
    const menu = page.getByRole('button', { name: 'Navigation menu' })
    await menu.click()
    await page.keyboard.press('Escape')
    await expect(menu).toBeFocused()
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await page
      .getByLabel('PR URL', { exact: true })
      .fill('https://github.com/example/project/pull/42')
    await page.getByLabel('Agent settings', { exact: true }).selectOption(command)
    await page.getByRole('button', { name: 'Start walkthrough' }).click()
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    const original = (await getState()).sessions[0]
    await send('wait')
    await expect(page.locator('.status-badge')).toHaveText('Working')
    await page.getByLabel('Message your agent').fill('Check this later.')
    await page.getByRole('button', { name: 'Walkthroughs', exact: true }).click()
    const history = page.getByRole('list', { name: 'Saved walkthroughs' })
    await expect(history).toContainText('Working')
    await history.getByRole('button').click()
    await expect(page.locator('.status-badge')).toHaveText('Working')
    await expect(page.getByLabel('Message your agent')).toHaveValue('Check this later.')
    await navigate('Basic Agent Session')
    expect((await getState()).sessions.find((session) => session.id === original.id)?.status).toBe(
      'running',
    )
    await createSession('codex')
    await expect(page.locator('.message')).toHaveCount(0)
    await navigate('PR Walkthrough')
    await history.getByRole('button').click()
    await expect(page.locator('.status-badge')).toHaveText('Working')
    await expect(page.getByText('Turn stopped.')).toHaveCount(0)
    await expect(page.getByLabel('Message your agent')).toHaveValue('Check this later.')
    await page.getByRole('button', { name: 'Stop turn' }).click()
    await expect(page.getByText('Turn stopped.')).toBeVisible()
    await expect(page.locator('.status-badge')).toHaveText('Ready')

    await send('background')
    await expect(page.locator('.status-badge')).toHaveText('Working')
    await navigate('Basic Agent Session')
    await writeFile(env.SHERPA_FIXTURE_COMPLETE, 'finish')
    await expect
      .poll(
        async () =>
          (await getState()).sessions.find((session) => session.id === original.id)?.status,
      )
      .toBe('idle')
    await navigate('PR Walkthrough')
    await expect(history).toContainText('Ready')
    await history.getByRole('button').click()
    await expect(page.locator('.message.assistant').last()).toHaveText(
      /Finished while you were away\./,
    )
    await expect(page.locator('.message.assistant')).toHaveCount(2)

    await send('approval')
    await expect(page.locator('.status-badge')).toHaveText('Needs input')
    await navigate('PR Walkthrough')
    await expect(history).toContainText('Needs input')
    await history.getByRole('button').click()
    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.locator('.message.assistant').last()).toContainText('Approved by you.')
    await expect(page.locator('.status-badge')).toHaveText('Ready')
  })
}

test('walkthrough exposes config errors and recovers after retry', async () => {
  await app.close()
  const config = await readFile(env.SHERPA_CONFIG_FILE, 'utf8')
  await writeFile(env.SHERPA_CONFIG_FILE, '{broken')
  await launch('PR Walkthrough')
  await expect(page.getByRole('alert')).toContainText('The file is unchanged')
  await expect(page.getByRole('button', { name: 'Start walkthrough' })).toBeDisabled()
  await writeFile(env.SHERPA_CONFIG_FILE, config)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Agent settings', { exact: true })).toHaveValue('codex')
})

test('creates integration-specific settings and preserves them across fresh installations', async () => {
  await expect(page.locator('.command-label strong')).toHaveText(['codex', 'claude', 'pi'])
  await page.getByRole('button', { name: 'Add integration' }).click()
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByLabel('Integration', { exact: true }).selectOption('pi')
  await page.getByLabel('Name', { exact: true }).fill('Pi Work')
  await page.getByLabel('Provider', { exact: true }).fill('openai')
  await page.getByLabel('Model', { exact: true }).fill('test-model')
  await page.getByLabel('Thinking level').selectOption('high')
  await expect(page.getByLabel('Approval policy')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/pi-settings.png' })
  await page.getByRole('button', { name: 'Save settings' }).click()
  const config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(config.version).toBe(2)
  expect(config.profiles.at(-1)).toMatchObject({
    name: 'Pi Work',
    harness: 'pi',
    options: { provider: 'openai', model: 'test-model', thinking: 'high' },
  })
  expect(config.profiles.at(-1)).not.toHaveProperty('command')
  await app.close()
  env.SHERPA_DATA_DIR = join(directory, 'fresh-install-data')
  await launch()
  await createSession('Pi Work')
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Pi')
  expect(JSON.parse(await readFile(env.SHERPA_FIXTURE_ARGV, 'utf8'))).toEqual([
    '--mode',
    'rpc',
    '--provider',
    'openai',
    '--model',
    'test-model',
    '--thinking',
    'high',
  ])
})

test('cancels edits, validates Pi provider/model, and resets options when changing integrations', async () => {
  const original = await readFile(env.SHERPA_CONFIG_FILE, 'utf8')
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  await page.getByLabel('Model', { exact: true }).fill('discard')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).toBe(original)
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  await page.getByLabel('Model', { exact: true }).press('Escape')
  await expect(page.getByLabel('Integration', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  await page.getByLabel('Approval policy').selectOption('never')
  await page.getByLabel('CODEX_HOME', { exact: true }).fill('/tmp/codex-config')
  await page.getByLabel('Integration', { exact: true }).selectOption('pi')
  await expect(page.getByLabel('PI_CODING_AGENT_DIR', { exact: true })).toHaveValue('')
  await page.getByLabel('Provider', { exact: true }).fill('openai')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toContainText('requires a model')
  expect(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).toBe(original)
  await page.getByLabel('Integration', { exact: true }).selectOption('claude')
  await expect(page.getByLabel('Provider', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Approval policy')).toHaveCount(0)
  await page.getByLabel('Name', { exact: true }).fill('Claude Work')
  await page.getByLabel('Model', { exact: true }).fill('sonnet')
  await page.getByLabel('Effort', { exact: true }).selectOption('high')
  await page.getByLabel('Permission mode').selectOption('acceptEdits')
  await page.getByLabel('Maximum turns').fill('8')
  await page.screenshot({ path: 'test-results/claude-settings.png' })
  await page.getByRole('button', { name: 'Save settings' }).click()
  const saved = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(saved.profiles[0]).toEqual({
    id: 'codex',
    name: 'Claude Work',
    harness: 'claude',
    options: { model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', maxTurns: 8 },
  })
  await createSession('Claude Work')
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Claude Code')
})

test('edits Codex settings and applies the selected permission policy', async () => {
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Luna')
  await page.getByLabel('Model', { exact: true }).fill('test-model')
  await page.getByLabel('Reasoning effort').selectOption('medium')
  await page.getByLabel('Approval policy').selectOption('never')
  await page.getByLabel('Sandbox', { exact: true }).selectOption('danger-full-access')
  await page.screenshot({ path: 'test-results/codex-settings.png' })
  await page.getByRole('button', { name: 'Save settings' }).click()
  await app.close()
  await launch()
  await createSession('Luna')
  await expect(page.locator('.conversation-command')).toHaveText('Luna')
  const trace = (await readFile(env.SHERPA_FIXTURE_TRACE, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(trace.find((record) => record.method === 'thread/start').params).toMatchObject({
    model: 'test-model',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: { model_reasoning_effort: 'medium' },
  })
  await send('approval')
  await expect(page.locator('.message.assistant').last()).toContainText(
    'Command ran without approval.',
  )
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
})

test('deletes profiles including the default and final entry across restarts', async () => {
  await page.getByRole('button', { name: 'Delete codex', exact: true }).click()
  await expect(page.locator('.command-label strong')).toHaveText(['claude', 'pi'])
  expect(
    JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).defaultProfileId,
  ).toBeUndefined()
  await app.close()
  await launch()
  await page.getByRole('button', { name: 'Delete claude', exact: true }).click()
  await page.getByRole('button', { name: 'Delete pi', exact: true }).click()
  await expect(page.getByText('No integrations saved.', { exact: false })).toBeVisible()
  expect(JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).profiles).toEqual([])
  await addIntegration('codex')
  await createSession('Codex')
})

test('migrates old profiles and requires review for unsupported command flags', async () => {
  await app.close()
  await writeFile(
    env.SHERPA_CONFIG_FILE,
    JSON.stringify({
      version: 1,
      profiles: [
        { id: 'legacy', name: 'Old Work', command: 'codex --model example --profile work' },
        { id: 'known', name: 'Known', command: 'pi --model example --thinking high' },
      ],
    }),
  )
  await launch()
  await expect(page.getByRole('button', { name: 'Old Work', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Known', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Edit Old Work' }).click()
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('example')
  await expect(page.getByText('Unsupported argument: --profile')).toBeVisible()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await createSession('Old Work')
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Codex')
  const config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(config.version).toBe(2)
  expect(config.profiles[0]).not.toHaveProperty('migration')
})

test('Codex: chat, tools, approvals, questions, cancellation, and back to commands', async () => {
  await createSession('codex')
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Codex')
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  await page.locator('.tool-message summary').first().click()
  await expect(page.locator('.tool-body')).toContainText('A project readme.')
  await send('approval')
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page.locator('.message.assistant').last()).toContainText('Denied by you.')
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  await send('question')
  await page.getByRole('button', { name: 'Green', exact: true }).click()
  await page.getByRole('button', { name: 'Send answer' }).click()
  await expect(page.locator('.message.assistant').last()).toContainText('You chose Green.')
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  await send('wait')
  await page.getByRole('button', { name: 'Stop turn' }).click()
  await expect(page.getByText('Turn stopped.')).toBeVisible()
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  await page.screenshot({ path: 'test-results/conversation.png' })
  expect(
    await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
  ).toBe('undefined')
  await expect(
    page.evaluate(() => window.sherpa?.openExternal('file:///etc/passwd')),
  ).rejects.toThrow('Only web links')
  await expect(
    page.evaluate(() => window.sherpa?.createSession({ profileId: 'unknown', cwd: '/' })),
  ).rejects.toThrow()
  await send('wait')
  await page.getByRole('button', { name: 'Integrations', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Basic Agent Session' })).toBeVisible()
  await expect.poll(async () => (await getState()).sessions[0].status).toBe('running')
  await createSession('pi')
  await expect(page.locator('.message')).toHaveCount(0)
  await page.getByRole('button', { name: 'Integrations', exact: true }).click()
  await page
    .getByRole('list', { name: 'Saved sessions' })
    .getByRole('button')
    .filter({ hasText: 'hello' })
    .click()
  await expect(page.locator('.status-badge')).toHaveText('Working')
  await page.getByRole('button', { name: 'Stop turn' }).click()
  await expect(page.locator('.status-badge')).toHaveText('Ready')
})

for (const [command, name] of [
  ['pi', 'Pi'],
  ['claude', 'Claude Code'],
]) {
  test(`${name}: streaming and approvals through the selected command`, async () => {
    await createSession(command)
    await send('hello')
    await expect(page.locator('.message.assistant')).toContainText(`Hello from ${name}`)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    await send('approval')
    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.locator('.message.assistant').last()).toContainText('Approved by you.')
  })
}

test('recovers a legacy session with reviewed settings and retains its native conversation', async () => {
  await createSession('codex')
  await send('hello')
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  const original = (await getState()).sessions[0]
  await app.close()
  const path = join(env.SHERPA_DATA_DIR, 'sessions.json')
  const data = JSON.parse(await readFile(path, 'utf8'))
  delete data.sessions[0].settings
  data.sessions[0].launchCommand = 'codex --profile old'
  await writeFile(path, JSON.stringify(data))
  await launch()
  await page.getByRole('list', { name: 'Saved sessions' }).getByRole('button').click()
  await expect(
    page.getByText('This session’s old command needs review.', { exact: false }),
  ).toBeVisible()
  await page.getByLabel('Resume with settings', { exact: true }).selectOption('codex')
  await page.getByRole('button', { name: 'Use these settings' }).click()
  await expect(page.getByLabel('Resume with settings', { exact: true })).toHaveCount(0)
  await send('continue')
  await expect(page.locator('.message.assistant')).toHaveCount(2)
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  await expectNativeResume('codex', original.resumeId, 1)
  expect((await getState()).sessions[0].id).toBe(original.id)
})

for (const [harness, variable] of [
  ['codex', 'CODEX_HOME'],
  ['claude', 'CLAUDE_CONFIG_DIR'],
  ['pi', 'PI_CODING_AGENT_DIR'],
]) {
  test(`${harness}: configuration directory reaches the process and survives profile edits and restart`, async () => {
    const configured = join(directory, 'agent home with spaces')
    await page.getByRole('button', { name: `Edit ${harness}`, exact: true }).click()
    await page.getByLabel(variable, { exact: true }).fill(configured)
    await page.getByRole('button', { name: 'Save settings' }).click()
    await createSession(harness)
    await send('original account')
    await expect(page.locator('.message.assistant')).toHaveCount(1)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    const original = (await getState()).sessions[0]
    expect(original.settings?.configDir).toBe(configured)
    expect(JSON.parse(await readFile(env.SHERPA_FIXTURE_ENV, 'utf8'))[variable]).toBe(configured)
    await page.getByRole('button', { name: 'Integrations', exact: true }).click()
    await page.getByRole('button', { name: `Edit ${harness}`, exact: true }).click()
    await expect(page.getByLabel(variable, { exact: true })).toHaveValue(configured)
    await page.getByLabel(variable, { exact: true }).fill('')
    await page.getByRole('button', { name: 'Save settings' }).click()
    expect(
      (await getState()).config.profiles.find((profile) => profile.id === harness),
    ).not.toHaveProperty('configDir')
    await app.close()
    await launch()
    await page.getByRole('list', { name: 'Saved sessions' }).getByRole('button').click()
    await send('continue with original account')
    await expect(page.locator('.message.assistant')).toHaveCount(2)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    expect(JSON.parse(await readFile(env.SHERPA_FIXTURE_ENV, 'utf8'))[variable]).toBe(configured)
    expect((await getState()).sessions[0].resumeId).toBe(original.resumeId)
    await page.getByRole('button', { name: 'Integrations', exact: true }).click()
    await createSession(harness)
    await send('inherited account')
    await expect(page.locator('.message.assistant')).toHaveCount(1)
    await expect(page.locator('.status-badge')).toHaveText('Ready')
    const childEnv = JSON.parse(await readFile(env.SHERPA_FIXTURE_ENV, 'utf8'))
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'])
      expect(childEnv[key]).toBe(env[key])
  })
}

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'

let app: ElectronApplication
let page: Page
let directory: string
let env: Record<string, string>
const pageErrors: string[] = []

async function launch() {
  app = await _electron.launch({ args: [resolve('out/main/index.js')], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await expect(page.getByRole('heading', { name: 'Agent commands' })).toBeVisible()
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
  }
  await writeFile(
    env.SHERPA_CONFIG_FILE,
    JSON.stringify({
      version: 1,
      defaultProfileId: 'codex',
      profiles: ['codex', 'claude', 'pi'].map((harness) => ({
        id: harness,
        name: harness,
        command: harness,
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
    .getByRole('list', { name: 'Saved commands' })
    .getByRole('button', { name: command, exact: true })
    .click()
  await expect(page.locator('.status-badge')).toHaveText('Ready')
}

async function addCommand(command: string, name = '') {
  await page.getByRole('button', { name: 'Add command' }).click()
  await expect(page.getByRole('textbox')).toHaveCount(2)
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
  await page.getByRole('textbox', { name: 'Agent command' }).fill(command)
  await page.getByRole('textbox', { name: 'Agent command' }).press('Enter')
  await expect(page.getByRole('textbox', { name: 'Agent command' })).toHaveCount(0)
}

async function send(text: string) {
  await page.getByLabel('Message your agent').fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

test('shows saved commands, adds through separate fields, and keeps them across fresh installations', async () => {
  await expect(page.locator('.command-list code')).toHaveText(['codex', 'claude', 'pi'])
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.locator('.command-launch')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Add command' })).toBeVisible()
  await page.screenshot({ path: 'test-results/commands.png' })
  const command = 'pi --custom-profile "two words"'
  await addCommand(command)
  const config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(config.profiles[config.profiles.length - 1]).toMatchObject({ command, harness: 'pi' })
  expect((await page.evaluate(() => window.sherpa?.getState())).sessions).toHaveLength(0)
  await app.close()
  env.SHERPA_DATA_DIR = join(directory, 'fresh-install-data')
  await launch()
  await expect(page.locator('.command-list code')).toHaveText(['codex', 'claude', 'pi', command])
  await createSession(command)
  await expect(page.locator('.conversation-command')).toHaveText(command)
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Pi')
})

test('starts empty, allows cancelling Add, and preserves invalid input for correction', async () => {
  await app.close()
  await rm(env.SHERPA_CONFIG_FILE)
  await launch()
  await expect(page.getByText('No commands saved.')).toBeVisible()
  await expect(page.locator('.command-list button')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add command' }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await page.getByLabel('Agent command', { exact: true }).fill('discard me')
  await page.getByLabel('Agent command', { exact: true }).press('Escape')
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add command' }).click()
  await page.getByLabel('Agent command', { exact: true }).fill('codex | cat')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('wrapper script')
  expect(JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).profiles).toEqual([])
  await page.getByLabel('Agent command', { exact: true }).fill('codex')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await createSession('codex')
})

test('asks for an unknown wrapper type only on first launch', async () => {
  await addCommand('my-agent --work')
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await page.getByRole('button', { name: 'my-agent --work', exact: true }).click()
  await page.getByLabel('Agent type').selectOption('pi')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.locator('.status-badge')).toHaveText('Ready')
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Pi')
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await createSession('my-agent --work')
  expect(JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).profiles.at(-1).harness).toBe(
    'pi',
  )
})

test('edits a saved command inline, persists it, and launches its new agent', async () => {
  const original = await readFile(env.SHERPA_CONFIG_FILE, 'utf8')
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Agent command' })
  await expect(input).toHaveValue('codex')
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused()
  await input.fill('discard this edit')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).toBe(original)
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  await input.fill('also discard')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  expect(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).toBe(original)
  await page.getByRole('button', { name: 'Edit codex', exact: true }).click()
  await input.fill('')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await input.fill('pi')
  await input.press('Enter')
  await expect(page.getByRole('alert')).toContainText('already saved')
  expect(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).toBe(original)
  const command = 'pi --custom-profile work'
  await input.fill(command)
  await page.screenshot({ path: 'test-results/edit-command.png' })
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.command-list code')).toHaveText([command, 'claude', 'pi'])
  const saved = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(saved.profiles[0]).toMatchObject({ id: 'codex', command, harness: 'pi' })
  expect((await page.evaluate(() => window.sherpa?.getState())).sessions).toHaveLength(0)
  await app.close()
  await launch()
  await createSession(command)
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Pi')
})

test('names, renames, launches, and deletes a command using separate fields', async () => {
  const command =
    'codex -c "model=gpt-6-luna" -c "model_reasoning_effort=medium" --dangerously-bypass-approvals-and-sandbox'
  await addCommand(command, 'Luna')
  await expect(page.getByRole('button', { name: 'Luna', exact: true })).toBeVisible()
  await expect(page.locator('.command-list code').last()).toHaveText(command)
  let config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  const id = config.profiles[config.profiles.length - 1].id
  expect(config.profiles[config.profiles.length - 1]).toMatchObject({
    name: 'Luna',
    command,
    harness: 'codex',
  })
  await page.screenshot({ path: 'test-results/named-command.png' })
  await app.close()
  env.SHERPA_DATA_DIR = join(directory, 'fresh-install-data')
  await launch()
  await page.getByRole('button', { name: 'Edit Luna', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Luna')
  await expect(page.getByRole('textbox', { name: 'Agent command' })).toHaveValue(command)
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Luna Work')
  await page.screenshot({ path: 'test-results/named-command-editor.png' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(config.profiles[config.profiles.length - 1]).toMatchObject({
    id,
    name: 'Luna Work',
    command,
    harness: 'codex',
  })
  await createSession('Luna Work')
  await expect(page.locator('.conversation-command')).toHaveText('Luna Work')
  const args = JSON.parse(await readFile(env.SHERPA_FIXTURE_ARGV, 'utf8'))
  expect(args.slice(0, 5)).toEqual([
    '-c',
    'model=gpt-6-luna',
    '-c',
    'model_reasoning_effort=medium',
    '--dangerously-bypass-approvals-and-sandbox',
  ])
  await send('hello')
  await expect(page.locator('.message.assistant')).toContainText('Hello from Codex')
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Luna Work', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Luna Work', exact: true })).toHaveCount(0)
  config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(config.profiles.some((profile: { id: string }) => profile.id === id)).toBe(false)
})

test('deletes saved commands, including the default and final entry, across restarts', async () => {
  await page.getByRole('button', { name: 'Delete codex', exact: true }).click()
  await expect(page.locator('.command-list code')).toHaveText(['claude', 'pi'])
  const config = JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8'))
  expect(config.defaultProfileId).toBeUndefined()
  expect(config.profiles.map((p: { command: string }) => p.command)).toEqual(['claude', 'pi'])
  expect((await page.evaluate(() => window.sherpa?.getState())).sessions).toHaveLength(0)
  await app.close()
  await launch()
  await expect(page.locator('.command-list code')).toHaveText(['claude', 'pi'])
  await page.getByRole('button', { name: 'Delete claude', exact: true }).click()
  await page.getByRole('button', { name: 'Delete pi', exact: true }).click()
  await expect(page.getByText('No commands saved.')).toBeVisible()
  expect(JSON.parse(await readFile(env.SHERPA_CONFIG_FILE, 'utf8')).profiles).toEqual([])
  await app.close()
  await launch()
  await expect(page.getByText('No commands saved.')).toBeVisible()
  await addCommand('codex')
  await createSession('codex')
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
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agent commands' })).toBeVisible()
  expect((await page.evaluate(() => window.sherpa?.getState())).sessions[0].status).toBe('idle')
  await createSession('pi')
  await expect(page.locator('.message')).toHaveCount(0)
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

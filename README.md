# Inistate Portal kit

A [Claude Code](https://claude.com/claude-code) skill for building your own **Inistate portal pages**: dashboards your
team opens from Inistate's **Portals** menu, and form pages an activity (such as Create or Approve) opens instead of
its standard form. You describe the page in plain words, Claude builds and checks it, you try it on your own computer
with your workspace's real data, and you publish it yourself from Inistate's **Settings › Portals**.

Every page opens with each member's own Inistate sign-in, so it shows and does only what that person can already see
and do in Inistate.

## What you need

- **Windows**, with [Claude](https://claude.ai/download) (the **Code** tab), [Google Chrome](https://www.google.com/chrome/),
  [Node.js](https://nodejs.org/) (LTS) and [Git](https://git-scm.com/download/win).
- A **workspace admin** seat in the Inistate workspace you build for.
- Claude connected to Inistate: in Claude, **Settings › Connectors › Browse connectors › Inistate › Connect**.

## Install

Open **Windows PowerShell** and paste these lines one at a time:

```powershell
git clone https://github.com/Inistate/portal-kit.git "$env:USERPROFILE\portal-kit"
```

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\portal-kit\kit\install.ps1"
```

```powershell
npm install --prefix "$env:USERPROFILE\tools" playwright-core
```

```powershell
setx PLAYWRIGHT_CORE "$env:USERPROFILE\tools\node_modules\playwright-core"
```

Pages are kept in `D:\portals`. If the computer has no `D:` drive, choose another folder:

```powershell
setx PORTALS_ROOT "$env:USERPROFILE\Documents\portals"
```

Restart Claude, open the **Code** tab, and type `/portal`: the skill appears in the list.

To update later, run `git -C "$env:USERPROFILE\portal-kit" pull`, then the `install.ps1` line again.

## Use

| Type in Claude | What happens |
|---|---|
| `/portal brief "<workspace>" "<module>" …` | Claude looks up the names of the modules, fields and listings the page needs. Names only, never your data. |
| Your own words, e.g. *"Make a dashboard of this month's invoices…"* | Claude builds the page from the template and checks it on a phone-sized and a laptop-sized screen. |
| `/portal try` | The page runs on your computer with your real data, after you press **Allow** in Inistate. |
| `/portal deploy` | Claude gives you a Publish link. You check the **Publish a portal** window in Inistate and press **Publish**. |
| `/portal deploy --undo` | Opens the portal's **Versions**, where you can restore an earlier one. |

Nothing goes live until you press **Publish** yourself. During `/portal try`, anything the page saves is saved for
real; try pages that write in a test workspace.

## What is in this repository

| Folder | What it holds |
|---|---|
| `kit/SKILL.md` | The skill Claude follows |
| `kit/template/` | The page every portal starts from |
| `kit/samples/` | Two worked examples: a dashboard that reads (`leave-overview`) and a form page an activity opens (`claim-approval`) |
| `kit/sdk/portal-v1.js` | The Inistate portal SDK. Pages carry it inline and unchanged; Inistate refuses a page whose copy was edited. |
| `kit/dev/` | The checks, the local server, and the publish helper the skill runs |
| `tests/` | Checks for the kit itself |

## Checking the kit itself

```powershell
npm install
npm test
```

The checks drive the Chrome installed on the computer; nothing else is downloaded.

## Licence

[MIT](LICENSE). Pages you build with the kit are yours. Publishing them still needs an Inistate workspace, and
Inistate checks every page it accepts.

import type { Route, RouteHandler } from './route.ts'
import { escapeHtml } from './html.ts'
import { defectOf, handled, PAGE_HELPERS, readJson, sendJson, sendPage, stringField, Visitors, workflowPage } from './workflow-page.ts'

/** Where the small site of family 1 lives. */
export const SITE_PATH = '/workflow/site'

const projects = [
  { slug: 'apollo', name: 'Apollo', summary: 'The launch checklist for the spring release.' },
  { slug: 'borealis', name: 'Borealis', summary: 'Moving the team to the northern office.' },
] as const

// The menu every page of the site shows. The `wrong-link` defect points Settings at the projects page, as a
// mistyped route would.
function menu(defect: string | undefined): string {
  const settings = defect === 'wrong-link' ? `${SITE_PATH}/projects` : `${SITE_PATH}/settings`
  return `<nav aria-label="Main"><a href="${SITE_PATH}">Home</a> <a href="${SITE_PATH}/projects">Projects</a> <a href="${settings}">Settings</a></nav>`
}

function homePage(defect: string | undefined): string {
  return workflowPage('Home', `${menu(defect)}\n<p data-testid="welcome">Welcome back. Pick a project to carry on.</p>`)
}

function projectsPage(): string {
  const items = projects.map((project) => `<li><a href="${SITE_PATH}/projects/${project.slug}">${project.name}</a></li>`).join('\n')
  return workflowPage('Projects', `${menu(undefined)}\n<ul data-testid="project-links">\n${items}\n</ul>`)
}

function projectPage(project: (typeof projects)[number]): string {
  return workflowPage(
    project.name,
    `${menu(undefined)}
<p data-testid="summary">${project.summary}</p>
<p><a href="${SITE_PATH}/projects">Back to projects</a></p>`,
  )
}

// The settings page counts its loads in this tab in sessionStorage, which a reload keeps and a new context does
// not, so a test can tell a reload loaded the document again. The display name is saved on the server; the
// draft note is never saved, so a reload loses it. Both fields turn form restoring off, so after a reload they show
// what the server sent, not text a browser kept: Firefox restores a textarea's text on reload unless told not to. The
// two sections are client-side routes: a tab moves to a new path within the document, and loading that path opens
// its section.
const SETTINGS_SCRIPT = `${PAGE_HELPERS}
const loads = Number(sessionStorage.getItem('workflow-settings-loads') ?? '0') + 1
sessionStorage.setItem('workflow-settings-loads', String(loads))
byTestId('loads').textContent = 'Loaded ' + loads + (loads === 1 ? ' time' : ' times') + ' in this tab'
const show = (section) => {
  byTestId('profile-section').hidden = section !== 'profile'
  byTestId('notifications-section').hidden = section !== 'notifications'
  byTestId('profile-tab').setAttribute('aria-selected', String(section === 'profile'))
  byTestId('notifications-tab').setAttribute('aria-selected', String(section === 'notifications'))
}
show(location.pathname.endsWith('/notifications') ? 'notifications' : 'profile')
byTestId('profile-tab').addEventListener('click', () => {
  history.pushState({}, '', '${SITE_PATH}/settings')
  show('profile')
})
byTestId('notifications-tab').addEventListener('click', () => {
  history.pushState({}, '', '${SITE_PATH}/settings/notifications')
  show('notifications')
})
byTestId('save-profile').addEventListener('click', async () => {
  const name = document.getElementById('display-name').value
  const response = await fetch('/workflow/api/site/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
  const saved = await response.json()
  byTestId('saved-name').textContent = saved.name
  byTestId('profile-status').textContent = 'Profile saved'
})
`

function settingsPage(savedName: string): string {
  return workflowPage(
    'Settings',
    `${menu(undefined)}
<div role="tablist" aria-label="Settings sections">
<button type="button" role="tab" data-testid="profile-tab">Profile</button>
<button type="button" role="tab" data-testid="notifications-tab">Notifications</button>
</div>
<section data-testid="profile-section">
<h2>Profile</h2>
<p><label for="display-name">Display name</label> <input id="display-name" autocomplete="off" value="${escapeHtml(savedName)}"></p>
<p><label for="draft">Draft note</label> <textarea id="draft" autocomplete="off"></textarea></p>
<p><button type="button" data-testid="save-profile">Save profile</button></p>
<p role="status" data-testid="profile-status"></p>
<p>Saved name: <span data-testid="saved-name">${escapeHtml(savedName)}</span></p>
</section>
<section data-testid="notifications-section" hidden>
<h2>Notifications</h2>
<p data-testid="notifications-intro">Choose which emails you get.</p>
</section>
<p data-testid="loads"></p>`,
    SETTINGS_SCRIPT,
  )
}

/**
 * Family 1, open a page, navigate and reload: a home page, a list of projects that link to their own pages, an
 * old address the server redirects, and a settings page whose saved name survives a reload and whose sections
 * are client-side routes. `?defect=wrong-link` on the home page breaks its Settings link.
 */
export function navigationRoutes(): Route[] {
  const profiles = new Visitors(() => ({ name: '' }))
  const showSettings: RouteHandler = (request, response) => sendPage(response, settingsPage(profiles.of(request, response).name))
  return [
    [`GET ${SITE_PATH}`, (request, response) => sendPage(response, homePage(defectOf(request)))],
    [`GET ${SITE_PATH}/projects`, (_request, response) => sendPage(response, projectsPage())],
    ...projects.map((project): Route => [`GET ${SITE_PATH}/projects/${project.slug}`, (_request, response) => sendPage(response, projectPage(project))]),
    [
      `GET ${SITE_PATH}/old-projects`,
      (_request, response) => {
        response.writeHead(302, { location: `${SITE_PATH}/projects`, 'cache-control': 'no-store' })
        response.end()
      },
    ],
    [`GET ${SITE_PATH}/settings`, showSettings],
    [`GET ${SITE_PATH}/settings/notifications`, showSettings],
    [
      'POST /workflow/api/site/profile',
      (request, response) => {
        const profile = profiles.of(request, response)
        handled(
          readJson(request).then((body) => {
            profile.name = (stringField(body, 'name') ?? '').trim()
            sendJson(response, 200, profile)
          }),
          response,
        )
      },
    ],
  ]
}

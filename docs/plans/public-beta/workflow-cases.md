# Basic workflow cases for Release 1

Written 3 October 2026 for Phase 1 item 2 of [the 0.1.0 handoff](release-0.1.0.md). This is the fixed list of basic workflow cases for families 1 to 10 of [the everyday workflow coverage target](releases.md#the-everyday-workflow-coverage-target), and the record the Release 1 gate is checked against. Each case runs on Chromium through the command line against real Chrome and the task app. Phase 3 is to run the same cases on Firefox and WebKit; none has run there yet. It is not a coverage percentage: Release 1 promises that every case here behaves as written, not a share of a larger set.

Every case has an ordinary passing path or a variation that matters, and every family has at least one case that must fail. A failing case counts only when it fails in its named step, at the line of its check, with the class and message below. Each integration file runs one project with all of its family's cases, with a 1.5 second assertion budget, and expects exit code 1 because of its failing cases.

The pages live under `/workflow/` in `fixtures/task-app/workflow-*.ts`. Data the server keeps is kept per browser context, by a visitor cookie, so every test starts from the same data. A page asked for with `?defect=<name>` behaves as a named regression would; the failing cases use those.

The cases use the methods themselves: `page.reload` (F1.2, F1.3, F4.1, F5.1, F5.2, F5.3, F7.1), `toHaveURL` (F1.3), `toBeChecked` and `.not` (F7.1, F7.2), `nth`, `first` and `last` on a scoped `getByRole` (F8.1) and `toBeEnabled` (F10.2). An earlier draft stood in for them while another lane added them, at 13 places in 10 cases; none is left.

F10.2's "Preparing export…" is held by the fixture until the test asks the server to finish the export, so that check never races a timer. F10.1's loading line shows for 600 ms after the page loads, and its first check comes right after `goto`.

## Family 1: open a page, navigate and reload

Pages: `fixtures/task-app/workflow-navigation-page.ts`.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F1.1 | Opens the home page by a relative URL, follows links to Projects, Apollo and back, opens a moved address the server redirects, and opens home by an absolute URL | Passes. Navigations are goto, three by action, the redirect's final page by goto, then goto | opens pages by link, by a moved address and by an absolute address | `tests/integration/workflow-navigation.test.ts` |
| F1.2 | Saves a display name, types a draft it does not save, and reloads the page | Passes. The page counts a second load, keeps the saved name and has lost the draft. Both fields turn form restoring off, so the check reads what the server sent: Firefox restores a textarea's text on reload unless told not to | a reload keeps the saved name and loses the unsaved draft | `tests/integration/workflow-navigation.test.ts` |
| F1.3 | Opens a settings section through a client-side route, checks the page's address, then reloads that route | Passes. The tab's navigation is a new path within the document, `toHaveURL` sees it, and the reload opens the same section in a new document | a section opened by a client-side route survives a reload | `tests/integration/workflow-navigation.test.ts` |
| F1.4 | Clicks a menu link the page points at the wrong route | Fails `check_failed` in step "open settings from the menu", at its `toHaveText('Settings')`: `getByTestId('heading') has text "Projects", expected "Settings"` | a menu link that leads to the wrong page fails at the heading check | `tests/integration/workflow-navigation.test.ts` |

## Family 2: password sign-in and sign-out

Pages: `fixtures/task-app/workflow-sign-in-page.ts`. The password is the secret `password`, read from the run's environment; no file of the run folder and neither output stream holds it.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F2.1 | Signs in with a user name and the secret password | Passes. The fill is recorded by the secret's name; the account page names the user and loads projects through the session | signs in with the password and lands on the account page | `tests/integration/workflow-sign-in.test.ts` |
| F2.2 | Signs in with a wrong password, then opens the account page | Passes. The page shows "Wrong user name or password" and stays on sign-in; the account page shows "Signed out" | a wrong password shows an error and leaves the person signed out | `tests/integration/workflow-sign-in.test.ts` |
| F2.3 | Signs in, signs out, then opens the account page | Passes. The server ended the session, so the account page shows "Signed out" and no projects | signing out ends the session | `tests/integration/workflow-sign-in.test.ts` |
| F2.4 | Signs out through a sign-out that leaves the session alive, then opens the account page | Fails `check_failed` in step "the account page shows signed out", at its `toHaveText('Signed out')`: `getByTestId('account') has text "Signed in as alice", expected "Signed out"` | a sign-out that keeps the session fails at the signed-out check | `tests/integration/workflow-sign-in.test.ts` |

## Family 3: reuse signed-in state

Pages: `fixtures/task-app/workflow-sign-in-page.ts`. The config declares the states `signed-in` and `admin`.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F3.1 | A setup signs in and saves `signed-in`; a test with `state: 'signed-in'` opens the account page | Passes. The setup runs first, the state is saved once and restored for each test that names it, and the session loads the projects | starts signed in from the saved state | `tests/integration/workflow-saved-state.test.ts` |
| F3.2 | A test without a state, run right after a signed-in one, opens the account page | Passes. It shows "Signed out" and nothing kept in the browser | starts signed out without a state, after a test that was signed in | `tests/integration/workflow-saved-state.test.ts` |
| F3.3 | One test from `signed-in` pins a project in local storage; the next test from the same state reads the pin | Passes. The next test starts from the saved state and sees no pin | pins a project while signed in; starts from the saved state, not from what the test before it changed | `tests/integration/workflow-saved-state.test.ts` |
| F3.4 | The setup `admin` signs in on a page whose server signs everyone in as guest; a test needs `admin` | The setup fails `check_failed` in step "the account page names admin": `getByTestId('account') has text "Signed in as guest", expected "Signed in as admin"`. The dependent test is `not_run` with the same class and location, and the message `Not run: the setup "admin" did not pass on chrome.` followed by the setup's message. It sends nothing to a page | admin (setup); opens the admin tools | `tests/integration/workflow-saved-state.test.ts` |

## Family 4: create an object through a form

Pages: `fixtures/task-app/workflow-tasks-page.ts`.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F4.1 | Fills a title and notes, selects a priority, adds the task, and reloads the board | Passes. The task is listed from the server's answer, the form is cleared, and the task is still there after the reload | adds a task with a title, notes and a priority | `tests/integration/workflow-create.test.ts` |
| F4.2 | Types a title and presses Enter in it | Passes. The form is submitted once and the task has the default priority | Enter in the title field adds the task with the default priority | `tests/integration/workflow-create.test.ts` |
| F4.3 | Adds a task, then adds the same title in other letter case | Passes. The server refuses it with `A task named "order badges" already exists.`, one task stays listed and the typed title stays in the field | refuses a second task with the same title and keeps what was typed | `tests/integration/workflow-create.test.ts` |
| F4.4 | Adds a task on a board whose server drops the title's last character | Fails `check_failed` in step "the new task is listed with its title": `getByTestId('task-title') has text "Release checklis", expected "Release checklist"` | a save that drops the last character fails at the listed title | `tests/integration/workflow-create.test.ts` |

## Family 5: edit and delete an object

Pages: `fixtures/task-app/workflow-tasks-page.ts`. The backlog starts with three tasks for every browser context. A row being deleted keeps its title until the server answers, so a list check cannot pass on the page's own guess before the server has deleted anything.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F5.1 | Edits one task's title and priority inline, saves, and reloads the backlog | Passes. The row changes, the others stay, and the reload shows the change | edits a task and the change survives a reload | `tests/integration/workflow-edit-delete.test.ts` |
| F5.2 | Asks to delete a task and cancels, then asks again and confirms, then reloads the backlog | Passes. Cancel keeps all three; confirm removes only that task, and the reload agrees | asks before deleting, keeps the task on cancel and removes it on confirm | `tests/integration/workflow-edit-delete.test.ts` |
| F5.3 | Edits a task on a backlog whose server answers as saved but keeps nothing, then reloads it | Fails `check_failed` in step "the change survives a reload": `Match 3 of getByTestId('item-title') has text "Order badges", expected "Order name badges"` | an edit the server never keeps fails after the reload | `tests/integration/workflow-edit-delete.test.ts` |
| F5.4 | Deletes a task on a backlog whose server removes the next row instead | Fails `check_failed` in step "only the deleted task is gone": `Match 2 of getByTestId('item-title') has text "Book venue", expected "Order badges"` | a delete that removes the wrong row fails at the remaining list | `tests/integration/workflow-edit-delete.test.ts` |

## Family 6: show validation errors

Pages: `fixtures/task-app/workflow-validation-page.ts`. The server counts the sign-ups it receives by name, and the integration test reads that count.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F6.1 | Submits a sign-up form with only a name | Passes. "Fix 3 problems to continue", an error under email, password and terms, none under name, and nothing reached the server | a form with only a name shows the email, password and terms errors, and sends nothing | `tests/integration/workflow-validation.test.ts` |
| F6.2 | Submits wrong values, corrects the fields one at a time, then submits a valid form | Passes. Five errors; correcting a field clears only its own; the valid form is accepted once | each wrong value gets its own message, fixing a field clears only its own, and a valid form is accepted | `tests/integration/workflow-validation.test.ts` |
| F6.3 | Submits a valid form with an email the server already has | Passes. The server's error shows beside the email field, the summary says one problem, and the typed values stay | an email the server knows is refused beside its field, and the typed values stay | `tests/integration/workflow-validation.test.ts` |
| F6.4 | Submits a three-character password on a form whose length rule is missing | Fails `check_failed` in step "the short password is refused": `getByTestId('password-error') has text "", expected "Use at least 8 characters"` | a form that accepts a short password fails at the password error | `tests/integration/workflow-validation.test.ts` |

## Family 7: select options, checkboxes and radios

Pages: `fixtures/task-app/workflow-selection-page.ts`. The page writes every control's state as one line of text.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F7.1 | Selects a plan by label, ticks a checkbox, chooses a radio, saves, and reloads the page | Passes. Each choice changes the form once, `toBeChecked` passes on the box and the radio before and after the reload, and the server's answer names all of them | chooses a plan, ticks a box and picks a theme, and the saved choices come back after a reload | `tests/integration/workflow-selection.test.ts` |
| F7.2 | Unticks a box ticked by default, selects by value, and chooses two radios of one group in turn | Passes. The box and the first radio are `.not.toBeChecked()`, and the second radio is checked | unticks a ticked box, chooses by value, and a second radio replaces the first | `tests/integration/workflow-selection.test.ts` |
| F7.3 | Selects the plan that reveals a seats select, chooses seats, then selects a plan that hides it | Passes. Seats exist only while that plan is chosen | the Business plan shows a seats choice that the other plans hide | `tests/integration/workflow-selection.test.ts` |
| F7.4 | Ticks a checkbox and saves on a page whose server ignores that field | Fails `check_failed` in step "the saved preferences match the form": the saved line reads `summary=off` where `summary=on` was expected | a save that ignores a checkbox fails at the saved summary | `tests/integration/workflow-selection.test.ts` |

## Family 8: find items in lists and tables

Pages: `fixtures/task-app/workflow-lists-page.ts`.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F8.1 | Counts the team table's rows, reads every row's text in order, reads cells by position inside a row, and finds two cells and a column header by name | Passes. `getByRole('row').nth(2)` scoped to its cells gives the member's name and email, and the last row's last cell its open tasks. `getByRole('row', { name })` found no row by its cells' text in Chrome, so a row is taken by position | reads the table row by row and finds a member by name | `tests/integration/workflow-lists.test.ts` |
| F8.2 | Sorts the table by name, then again the other way | Passes. The name column is in order each time | sorts the table by name one way and then the other | `tests/integration/workflow-lists.test.ts` |
| F8.3 | Counts sixty invoices, clicks one far below the first screen, and reads its page | Passes. One navigation by action, to the invoice's page with its amount | finds an invoice far down a long list and opens it | `tests/integration/workflow-lists.test.ts` |
| F8.4 | Sorts by open tasks on a table that compares the numbers as text | Fails `check_failed` in step "the open tasks go from fewest to most": `Match 1 of getByTestId('member-tasks') has text "10", expected "3"` | a sort that compares numbers as text fails at the sorted column | `tests/integration/workflow-lists.test.ts` |

## Family 9: search, filter and paginate

Pages: `fixtures/task-app/workflow-search-page.ts`. Every search is an ordinary form the browser submits to the server.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F9.1 | Types a search and presses Enter | Passes. One page from the server with the three matches, and the search box keeps the words | a search lists only the matching books | `tests/integration/workflow-search.test.ts` |
| F9.2 | Pages forward through every page of 23 books, then back one | Passes. Five titles a page, three on the last, no Previous on the first and no Next on the last | pages through every result and back | `tests/integration/workflow-search.test.ts` |
| F9.3 | Searches, narrows the search to one genre, then searches for words nothing matches | Passes. Three results, then one, then "No results" with no items and no pager | a genre filter narrows a search, and a search with no match says so | `tests/integration/workflow-search.test.ts` |
| F9.4 | Searches on a catalogue whose server ignores the words | Fails `check_failed` in step "only the matching books are listed": `getByTestId('result-count') has text "23 results", expected "3 results"` | a search that ignores its words fails at the result count | `tests/integration/workflow-search.test.ts` |

## Family 10: wait for loading and asynchronous UI state

Pages: `fixtures/task-app/workflow-async-page.ts`. The page asks for its reports after 300 ms and the server answers 300 ms later.

| Case | What it does | Intended outcome | Test name | File |
| --- | --- | --- | --- | --- |
| F10.1 | Opens the reports page and checks the loading line, the list and the loading line again | Passes. The list check looks more than once before the reports arrive | shows a loading line, then the reports that arrive late, and hides the line | `tests/integration/workflow-async.test.ts` |
| F10.2 | Waits for Export to be enabled, clicks it, checks "Preparing export…", releases the export at the server, and checks it finished | Passes. `toBeEnabled` passes once the reports are in, the click is sent once, and the status goes from "Preparing export…", held until the test releases it, to "Export ready: 3 reports" | waits for Export to be enabled, then for the export to finish | `tests/integration/workflow-async.test.ts` |
| F10.3 | Opens the page when the first answer is an error, and tries again | Passes. The error and its button show, and the second try loads the reports | offers to try again after a failed load, and loads on the second try | `tests/integration/workflow-async.test.ts` |
| F10.4 | Waits for the loading line to go on a page that never hides it | Fails `check_failed` after the whole 1.5 second budget, in step "the loading line goes once the reports are in": `getByTestId('loading') is visible.` | a loading line that never goes away fails at the hidden check | `tests/integration/workflow-async.test.ts` |
| F10.5 | Waits for reports from a server that holds the request past the check's budget | Fails `check_failed` after the whole 1.5 second budget, in step "the reports arrive": `getByTestId('report-row') matched no element, expected 3.` | reports that never arrive fail at the list check | `tests/integration/workflow-async.test.ts` |

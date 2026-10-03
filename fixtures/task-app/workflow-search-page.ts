import type { Route } from './route.ts'
import { escapeHtml } from './html.ts'
import { queryOf } from './route.ts'
import { sendPage, workflowPage } from './workflow-page.ts'

type Book = { title: string; author: string; genre: string }

/** The catalogue, in the order every search lists it. */
export const BOOKS: readonly Book[] = [
  { title: 'The Well-Tempered Garden', author: 'Christopher Lloyd', genre: 'Gardening' },
  { title: 'Garden Design Basics', author: 'Ruth Harlow', genre: 'Gardening' },
  { title: 'A Year in the Garden', author: 'Owen Fielding', genre: 'Gardening' },
  { title: 'The Secret History', author: 'Donna Tartt', genre: 'Fiction' },
  { title: 'Middlemarch', author: 'George Eliot', genre: 'Fiction' },
  { title: 'Beloved', author: 'Toni Morrison', genre: 'Fiction' },
  { title: 'The Remains of the Day', author: 'Kazuo Ishiguro', genre: 'Fiction' },
  { title: 'A Brief History of Time', author: 'Stephen Hawking', genre: 'Science' },
  { title: 'The Selfish Gene', author: 'Richard Dawkins', genre: 'Science' },
  { title: 'Cosmos', author: 'Carl Sagan', genre: 'Science' },
  { title: 'The Double Helix', author: 'James Watson', genre: 'Science' },
  { title: 'SPQR', author: 'Mary Beard', genre: 'History' },
  { title: 'The Guns of August', author: 'Barbara Tuchman', genre: 'History' },
  { title: 'A History of the World in 100 Objects', author: 'Neil MacGregor', genre: 'History' },
  { title: 'Postwar', author: 'Tony Judt', genre: 'History' },
  { title: 'The Silk Roads', author: 'Peter Frankopan', genre: 'History' },
  { title: 'Wolf Hall', author: 'Hilary Mantel', genre: 'Fiction' },
  { title: 'Rebecca', author: 'Daphne du Maurier', genre: 'Fiction' },
  { title: 'The Overstory', author: 'Richard Powers', genre: 'Fiction' },
  { title: 'Silent Spring', author: 'Rachel Carson', genre: 'Science' },
  { title: 'The Gene', author: 'Siddhartha Mukherjee', genre: 'Science' },
  { title: 'The Making of the Atomic Bomb', author: 'Richard Rhodes', genre: 'History' },
  { title: 'Planting in a Post-Wild World', author: 'Thomas Rainer', genre: 'Gardening' },
]

/** How many books one page of results shows. */
export const PAGE_SIZE = 5

const genres = ['Fiction', 'Gardening', 'History', 'Science'] as const

type Search = { query: string; genre: string; page: number; defect: string | undefined }

function searchOf(parameters: URLSearchParams): Search {
  const page = Number(parameters.get('page') ?? '1')
  return {
    query: (parameters.get('q') ?? '').trim(),
    genre: parameters.get('genre') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    defect: parameters.get('defect') ?? undefined,
  }
}

// The `ignores-query` defect drops the search words and keeps only the genre, as a query parameter the server
// stopped reading would.
function matches(search: Search): readonly Book[] {
  const words = search.defect === 'ignores-query' ? '' : search.query.toLowerCase()
  return BOOKS.filter(
    (book) =>
      (search.genre === '' || book.genre === search.genre) &&
      (words === '' || book.title.toLowerCase().includes(words) || book.author.toLowerCase().includes(words)),
  )
}

function addressOf(search: Search, page: number): string {
  const parameters = new URLSearchParams()
  if (search.query !== '') parameters.set('q', search.query)
  if (search.genre !== '') parameters.set('genre', search.genre)
  if (search.defect !== undefined) parameters.set('defect', search.defect)
  parameters.set('page', String(page))
  return `/workflow/catalog?${escapeHtml(parameters.toString())}`
}

function countText(count: number): string {
  if (count === 0) return 'No results'
  return count === 1 ? '1 result' : `${count} results`
}

function catalogPage(search: Search): string {
  const found = matches(search)
  const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE))
  const page = Math.min(search.page, pages)
  const shown = found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const genreOptions = genres.map((genre) => `<option${genre === search.genre ? ' selected' : ''}>${genre}</option>`).join('')
  const items = shown
    .map((book) => `<li><span data-testid="result-title">${escapeHtml(book.title)}</span> by ${escapeHtml(book.author)}, ${book.genre}</li>`)
    .join('\n')
  const previous = page > 1 ? `<a href="${addressOf(search, page - 1)}">Previous page</a> ` : ''
  const next = page < pages ? ` <a href="${addressOf(search, page + 1)}">Next page</a>` : ''
  const pager = found.length === 0 ? '' : `<nav aria-label="Pages">${previous}<span data-testid="page-status">Page ${page} of ${pages}</span>${next}</nav>`
  const defect = search.defect === undefined ? '' : `<input type="hidden" name="defect" value="${escapeHtml(search.defect)}">`
  return workflowPage(
    'Catalogue',
    `<form method="get" action="/workflow/catalog" role="search">
<label for="search">Search</label> <input id="search" name="q" type="search" autocomplete="off" value="${escapeHtml(search.query)}">
<label for="genre">Genre</label> <select id="genre" name="genre"><option value="">All genres</option>${genreOptions}</select>
${defect}<button type="submit">Search</button>
</form>
<p data-testid="result-count">${countText(found.length)}</p>
<ol data-testid="results">
${items}
</ol>
${pager}`,
  )
}

/**
 * Family 9, search, filter and paginate: a catalogue of 23 books the server searches by title or author, filters
 * by genre and splits into pages of five. Every search is an ordinary form the browser submits.
 * `?defect=ignores-query` searches as though no words were given.
 */
export function searchRoutes(): Route[] {
  return [['GET /workflow/catalog', (request, response) => sendPage(response, catalogPage(searchOf(queryOf(request))))]]
}

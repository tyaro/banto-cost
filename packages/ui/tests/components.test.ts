// @vitest-environment jsdom
/**
 * @banto/ui component contracts (docs/adr/0018-shared-ui-package.md §6): the
 * accessible names / roles the components own, every StatusBadge variant
 * always drawing an icon, the default/explicit LoadingState label, the
 * `icon` override, and snippet rendering. Visual output is covered by the
 * app-level visual regression suite (e2e/visual), not here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	defaultUiMessages,
	EmptyState,
	ErrorState,
	IconButton,
	LoadingState,
	PageHeader,
	StatusBadge,
	SurfaceCard,
	type StatusBadgeVariant
} from '../src/index';
import CustomIcon from './fixtures/CustomIcon.svelte';

afterEach(cleanup);

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

describe('IconButton', () => {
	it('puts the required label on aria-label and title, and fires onclick', async () => {
		const onclick = vi.fn();
		render(IconButton, { label: 'Close', icon: CustomIcon, onclick });
		const button = screen.getByRole('button', { name: 'Close' });
		expect(button.getAttribute('title')).toBe('Close');
		expect(button.getAttribute('type')).toBe('button');
		await fireEvent.click(button);
		expect(onclick).toHaveBeenCalledTimes(1);
	});

	it('sizes the icon 20px by default and 16px for size="sm"', () => {
		const { unmount } = render(IconButton, { label: 'a', icon: CustomIcon, onclick: () => {} });
		expect(screen.getByTestId('custom-icon').getAttribute('data-size')).toBe('20');
		unmount();
		render(IconButton, { label: 'a', icon: CustomIcon, size: 'sm', onclick: () => {} });
		expect(screen.getByTestId('custom-icon').getAttribute('data-size')).toBe('16');
		expect(screen.getByRole('button').classList.contains('icon-button--sm')).toBe(true);
	});

	it('hides the icon from assistive technology', () => {
		render(IconButton, { label: 'a', icon: CustomIcon, onclick: () => {} });
		expect(screen.getByTestId('custom-icon').getAttribute('aria-hidden')).toBe('true');
	});
});

describe('StatusBadge', () => {
	const variants: StatusBadgeVariant[] = ['neutral', 'success', 'warning', 'danger', 'info'];

	it.each(variants)('%s always renders an aria-hidden icon next to the label', (variant) => {
		const { container } = render(StatusBadge, { variant, label: `L-${variant}` });
		const badge = container.querySelector('.status-badge');
		expect(badge?.classList.contains(`status-badge--${variant}`)).toBe(true);
		expect(badge?.textContent?.trim()).toBe(`L-${variant}`);
		const svg = badge?.querySelector('svg');
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute('aria-hidden')).toBe('true');
		expect(svg?.getAttribute('width')).toBe('12');
	});

	it('uses a different bundled icon per variant', () => {
		const shapes = variants.map((variant) => {
			const { container, unmount } = render(StatusBadge, { variant, label: 'x' });
			const shape = container.querySelector('svg')?.innerHTML;
			unmount();
			return shape;
		});
		expect(new Set(shapes).size).toBe(variants.length);
	});

	it('lets `icon` override the default', () => {
		render(StatusBadge, { variant: 'info', label: 'x', icon: CustomIcon });
		expect(screen.getByTestId('custom-icon')).toBeTruthy();
	});
});

describe('LoadingState', () => {
	it('is a polite live region and announces the package default label', () => {
		render(LoadingState);
		const region = screen.getByRole('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(region.textContent).toContain(defaultUiMessages.loading());
		expect(defaultUiMessages.loading()).toBe('読み込み中…');
	});

	it('announces an explicit label instead of the default', () => {
		render(LoadingState, { label: 'Loading items…' });
		const region = screen.getByRole('status');
		expect(region.textContent).toContain('Loading items…');
		expect(region.textContent).not.toContain(defaultUiMessages.loading());
	});

	it('draws `lines` skeleton bars (aria-hidden), the last one short', () => {
		const { container } = render(LoadingState, { lines: 4 });
		const bars = container.querySelectorAll('.skeleton-line');
		expect(bars).toHaveLength(4);
		expect(bars[3].classList.contains('short')).toBe(true);
		expect(container.querySelector('.skeleton-lines')?.getAttribute('aria-hidden')).toBe('true');
	});
});

describe('ErrorState', () => {
	it('is a role="alert" with a heading, caption, default icon and optional action', () => {
		const { container } = render(ErrorState, {
			title: 'Failed',
			description: 'Try again',
			action: text('Retry')
		});
		const alert = screen.getByRole('alert');
		expect(screen.getByRole('heading', { level: 2, name: 'Failed' })).toBeTruthy();
		expect(alert.textContent).toContain('Try again');
		expect(alert.textContent).toContain('Retry');
		expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('svg')?.getAttribute('width')).toBe('32');
	});

	it('omits caption and action when not given, and honours `icon`', () => {
		const { container } = render(ErrorState, { title: 'Failed', icon: CustomIcon });
		expect(container.querySelector('p')).toBeNull();
		expect(container.querySelector('.action')).toBeNull();
		expect(screen.getByTestId('custom-icon')).toBeTruthy();
	});
});

describe('EmptyState', () => {
	it('renders heading, caption, default icon and action without role="alert"', () => {
		const { container } = render(EmptyState, {
			title: 'No data',
			description: 'Add one',
			action: text('Add')
		});
		expect(screen.getByRole('heading', { level: 2, name: 'No data' })).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(container.textContent).toContain('Add one');
		expect(container.querySelector('.action')?.textContent).toContain('Add');
		expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('honours `icon`', () => {
		render(EmptyState, { title: 'No data', icon: CustomIcon });
		expect(screen.getByTestId('custom-icon').getAttribute('data-size')).toBe('32');
	});
});

describe('PageHeader', () => {
	it('renders the single h1 with optional description and actions', () => {
		const { container } = render(PageHeader, {
			title: 'Items',
			description: 'All items',
			actions: text('New')
		});
		expect(screen.getByRole('heading', { level: 1, name: 'Items' })).toBeTruthy();
		expect(container.querySelector('header')?.textContent).toContain('All items');
		expect(container.querySelector('.actions')?.textContent).toContain('New');
	});

	it('omits the actions wrapper when no snippet is given', () => {
		const { container } = render(PageHeader, { title: 'Items' });
		expect(container.querySelector('.actions')).toBeNull();
		expect(container.querySelector('p')).toBeNull();
	});

	it('keeps an accessible h1, description and actions when the shell shows the title', () => {
		const { container } = render(PageHeader, {
			title: 'Items',
			hideTitle: true,
			description: 'All items',
			actions: text('New')
		});
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
		expect(screen.getByRole('heading', { name: 'Items' }).getAttribute('aria-hidden')).toBeNull();
		expect(container.querySelector('header')?.textContent).toContain('All items');
		expect(container.querySelector('.actions')?.textContent).toContain('New');
	});

	it('leaves only the document heading when the shell shows a title without description or actions', () => {
		const { container } = render(PageHeader, { title: 'Items', hideTitle: true });
		expect(screen.getByRole('heading', { level: 1, name: 'Items' })).toBeTruthy();
		expect(container.querySelector('header')).toBeNull();
	});
});

describe('SurfaceCard', () => {
	it('renders title, description, body and footer', () => {
		const { container } = render(SurfaceCard, {
			title: 'Card',
			description: 'Sub',
			children: text('Body'),
			footer: text('Foot')
		});
		expect(screen.getByRole('heading', { level: 2, name: 'Card' })).toBeTruthy();
		expect(container.querySelector('.body')?.textContent).toContain('Body');
		expect(container.querySelector('footer')?.textContent).toContain('Foot');
		expect(container.querySelector('header')?.textContent).toContain('Sub');
	});

	it('omits header and footer when none are given', () => {
		const { container } = render(SurfaceCard, { children: text('Body') });
		expect(container.querySelector('header')).toBeNull();
		expect(container.querySelector('footer')).toBeNull();
	});
});

/**
 * i18n layer 1 (docs/conventions.md §13): pure-module message override, mirrors
 * @banto/forms' `validate.ts` convention. `unknown` is the fallback text used
 * when the thrown value has no usable message.
 */
export interface ErrorMessages {
	unknown?: () => string;
}

const defaultErrorMessages: Required<ErrorMessages> = {
	unknown: () => '不明なエラーが発生しました'
};

/**
 * Extracts a display message from whatever `AttachmentsClient` rejected
 * with. The panel is transport-agnostic (attachments-plan §3.7) so it never imports
 * `@banto/admin-core`'s `ProviderError` - it only duck-types the
 * `{ message: string }` shape every error the app-side client can throw
 * already has (`ProviderError`, a plain `Error`, or anything else).
 */
export function errorMessage(err: unknown, messages: ErrorMessages = {}): string {
	const msg = { ...defaultErrorMessages, ...messages };
	if (
		err &&
		typeof err === 'object' &&
		'message' in err &&
		typeof (err as { message: unknown }).message === 'string'
	) {
		return (err as { message: string }).message;
	}
	if (typeof err === 'string') return err;
	return msg.unknown();
}

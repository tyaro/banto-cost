/**
 * Public entry point for @banto/image-assets (ADR-0020, shared-primitives-upstream-plan §3.7).
 * Browser-side image originals, import checks and object URL lifetimes, with no dependencies
 * and no display text (errors are codes, conventions §13).
 *
 * PR-12 shipped the shared ground: the formats, the consumer-supplied limits and their
 * validation, and the error codes. PR-13 adds the import checks (the header check before
 * decoding, the decode check after it) and the hash (D11). PR-14 adds the store of originals
 * (de-duplicated by hash, with a total size), shared object URLs and pin / release.
 */
export {
	IMAGE_FORMATS,
	validateImageImportLimits,
	type ImageFormat,
	type ImageImportLimits
} from './limits';
export { inspectImageHeader, type ImageBytes, type ImageHeader } from './header';
export {
	inspectImage,
	verifyDecodedImage,
	type DecodeOptions,
	type DecodedImage,
	type DecodedSize,
	type ImageDecoder,
	type ImageMetadata
} from './decode';
export { sha256Hex } from './sha256';
export {
	createImageStore,
	type AddImageOptions,
	type ImageStore,
	type ImageStoreOptions,
	type ImageUrlLease,
	type ObjectUrlFunctions
} from './store.svelte';
export {
	IMAGE_ASSET_ERROR_CODES,
	ImageAssetError,
	isImageAssetError,
	type ImageAssetErrorCode,
	type ImageAssetErrorDetail
} from './errors';

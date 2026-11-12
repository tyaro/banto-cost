/**
 * banto-cost（1人で使う、`admin_template_core::sole_user`）: アカウントが
 * 1件だけの間、デスクトップ版は起動時にその本人として自動でログインする。
 * その間はログアウトしても次の起動でまた自動でログインするだけなので、
 * ヘッダーとコマンドパレットのログアウトを隠す。2件目を追加したら出す。
 *
 * 判定はサーバー側（Tauri の `auth_sole_user`）。LAN のブラウザ・デモでは
 * 常に `false`（自動ログインはデスクトップ版だけ）。読み取りに失敗したら
 * `false`（ログアウトを出す側に倒す）。
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './environment';

let active = $state(false);
let request = 0;

export const soleUserStore = {
	/** いまのセッションが、アカウントが1件だけの間のその本人か。 */
	get active(): boolean {
		return active;
	}
};

/** 読み直す。セッションが変わったとき、ユーザーを追加・削除したときに呼ぶ。 */
export async function refreshSoleUser(): Promise<void> {
	const mine = ++request;
	let next = false;
	if (isTauri()) {
		try {
			next = (await invoke('auth_sole_user')) === true;
		} catch {
			next = false;
		}
	}
	// 古い問い合わせの答えで新しい答えを上書きしない。
	if (mine === request) active = next;
}

import * as vscode from 'vscode';
import { hostStrings } from '../shared/l10n';
import type { SettingKey } from '../settings';
import { kindOf, type CatalogFamily, type FontKind, type UserFonts } from './googleFonts';

/** Для какой настройки выбирается шрифт: `panels` — все семейства, «Применить» пишет `font.panels`. */
export type FontTarget = FontKind | 'panels';
import type { Logger } from './logger';
import { currentLanguage } from './webviewHost';

export interface GoogleFontsCommandDeps {
  fonts: UserFonts;
  log: Logger;
  /** Записать настройку туда, где она задана (как `feed.style`). */
  write(key: SettingKey, value: string): Promise<void>;
}

interface Item extends vscode.QuickPickItem {
  font: CatalogFamily;
}

/**
 * «Agentura: Add Google Font…»: QuickPick со всем каталогом (`kind` `code` / `ui` — только моноширинные или только
 * остальные; `panels` и из палитры — все),
 * загрузка выбранного, затем «Применить». Сеть — только здесь, по действию пользователя.
 */
export async function addGoogleFont(deps: GoogleFontsCommandDeps, kind?: FontTarget): Promise<void> {
  const { fonts, log } = deps;
  const t = hostStrings(currentLanguage());
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = t.fontPickPlaceholder;
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.title = t.fontPickLoading;
  const picked = new Promise<CatalogFamily | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]?.font));
    qp.onDidHide(() => resolve(undefined));
  });
  qp.show();
  try {
    const [catalog, have] = await Promise.all([fonts.catalog(), fonts.list()]);
    const done = new Set(have.map((f) => f.family));
    qp.items = catalog
      .filter((f) => kind === undefined || kind === 'panels' || kindOf(f.category) === kind)
      .map((f) => ({
        label: `${done.has(f.family) ? '$(check) ' : ''}${f.family}`,
        description: [f.category, f.subsets.includes('cyrillic') ? t.fontCyrillic : '', done.has(f.family) ? t.fontDownloaded : '']
          .filter(Boolean)
          .join(' · '),
        font: f,
      }));
    qp.title = undefined;
    qp.busy = false;
  } catch (e) {
    log.warn('agentura.addGoogleFont: каталог', e);
    qp.dispose();
    void vscode.window.showErrorMessage(t.fontCatalogFailed(e instanceof Error ? e.message : String(e)));
    return;
  }
  const font = await picked;
  qp.dispose();
  if (!font) return;

  const have = (await fonts.list()).some((f) => f.family === font.family);
  try {
    if (!have) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t.fontDownloading(font.family) },
        () => fonts.add(font),
      );
    }
  } catch (e) {
    log.warn(`agentura.addGoogleFont: ${font.family}`, e);
    void vscode.window.showErrorMessage(t.fontFailed(font.family, e instanceof Error ? e.message : String(e)));
    return;
  }
  const apply = await vscode.window.showInformationMessage(t.fontReady(font.family), t.fontApply);
  if (apply !== t.fontApply) return;
  try {
    const key: SettingKey =
      kind === 'panels' ? 'font.panels' : kindOf(font.category) === 'code' ? 'font.code' : 'font.interface';
    await deps.write(key, font.family);
  } catch (e) {
    log.warn('agentura.addGoogleFont: не записать настройку шрифта', e);
    void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  }
}

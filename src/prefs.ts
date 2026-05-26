// CodexBar preferences — global settings + per-provider cards
// (Name, Command, Poll, Warn at, Critical at, Notify).

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    AVAILABLE_ICONS,
    DEFAULT_WARN_PCT,
    DEFAULT_CRITICAL_PCT,
} from './lib/providers.js';

interface StoredProvider {
    id: string;
    name: string;
    command: string;
    icon?: string;
    pollSeconds?: number;
    warnPct?: number;
    criticalPct?: number;
    notify?: boolean;
}

// Seed used to build a provider card (a freshly added or restored provider).
interface ProviderSeed {
    id: string;
    name: string;
    defaultCommand: string;
    icon?: string;
}

interface ProviderRowRefs {
    id: string;
    row: Adw.ExpanderRow;
    nameEntry: Adw.EntryRow;
    commandEntry: Adw.EntryRow;
    getIcon: () => string;
    pollSpin: Adw.SpinRow;
    warnSpin: Adw.SpinRow;
    criticalSpin: Adw.SpinRow;
    notifySwitch: Adw.SwitchRow;
}

// Icon-selector model: "None" plus each bundled icon.
const ICON_CHOICES = ['', ...AVAILABLE_ICONS.map(i => i.file)];
const ICON_LABELS = ['None', ...AVAILABLE_ICONS.map(i => i.label)];

export default class CodexBarPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        page.add(this._buildGeneralGroup(settings));
        page.add(this._buildProvidersGroup(settings, window, `${this.path}/icons`));
        page.add(this._buildMaintenanceGroup(settings));
        page.add(this._buildAboutGroup());

        return Promise.resolve();
    }

    private _buildGeneralGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: _('Settings')});

        const refreshRow = new Adw.SpinRow({
            title: _('Refresh interval (minutes)'),
            subtitle: _('Global fallback. Per-provider "Poll every" overrides it.'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1440,
                step_increment: 1,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(refreshRow);

        const displayRow = new Adw.ComboRow({
            title: _('Display mode'),
            subtitle: _('Numeric/time text shows used or remaining quota.'),
            model: new Gtk.StringList({strings: [_('Used'), _('Remaining')]}),
            selected: settings.get_string('display-mode') === 'used' ? 0 : 1,
        });
        displayRow.connect('notify::selected', () => {
            settings.set_string('display-mode', displayRow.selected === 0 ? 'used' : 'remaining');
        });
        group.add(displayRow);

        return group;
    }

    private _buildProvidersGroup(
        settings: Gio.Settings,
        window: Adw.PreferencesWindow,
        iconsDir: string,
    ): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('AI Providers'),
            description: _('Each provider runs a codexbar CLI command and reports its usage.'),
        });

        const rows: ProviderRowRefs[] = [];

        let active: StoredProvider[] = [];
        try {
            active = JSON.parse(settings.get_string('providers'));
            if (!Array.isArray(active))
                active = [];
        } catch {
            active = [];
        }

        const saveProviders = () => {
            const out: StoredProvider[] = [];
            for (const r of rows) {
                if (!r.row.enable_expansion)
                    continue;
                out.push({
                    id: r.id,
                    name: r.nameEntry.get_text(),
                    command: r.commandEntry.get_text(),
                    icon: r.getIcon() || undefined,
                    pollSeconds: Math.round(r.pollSpin.get_value()) || undefined,
                    warnPct: Math.round(r.warnSpin.get_value()),
                    criticalPct: Math.round(r.criticalSpin.get_value()),
                    notify: r.notifySwitch.get_active(),
                });
            }
            settings.set_string('providers', JSON.stringify(out));
        };

        const makeCard = (info: ProviderSeed, stored: StoredProvider | null): ProviderRowRefs => {
            const enabled = stored !== null;

            const row = new Adw.ExpanderRow({
                title: info.name,
                show_enable_switch: true,
                enable_expansion: enabled,
                expanded: enabled,
            });

            // Icon shown to the left of the row title, reflecting the selection.
            const initialIcon = stored?.icon ?? info.icon ?? '';
            const iconImage = new Gtk.Image({pixel_size: 22});
            const applyIconPreview = (file: string) => {
                if (file)
                    iconImage.set_from_file(`${iconsDir}/${file}`);
                else
                    iconImage.set_from_icon_name('application-x-executable-symbolic');
            };
            applyIconPreview(initialIcon);
            row.add_prefix(iconImage);

            // Name.
            const nameEntry = new Adw.EntryRow({title: _('Name')});
            nameEntry.set_text(stored?.name ?? info.name);
            nameEntry.connect('changed', () => {
                row.set_title(nameEntry.get_text() || info.name);
                saveProviders();
            });
            row.add_row(nameEntry);

            // Command (codexbar CLI invocation producing JSON usage).
            const commandEntry = new Adw.EntryRow({title: _('Command')});
            commandEntry.add_css_class('monospace');
            commandEntry.set_text(stored?.command ?? info.defaultCommand);
            commandEntry.connect('changed', saveProviders);
            row.add_row(commandEntry);

            // Icon selector (bundled logos + "None").
            const iconRow = new Adw.ComboRow({
                title: _('Icon'),
                subtitle: _('Logo shown in the panel and dropdown'),
                model: new Gtk.StringList({strings: ICON_LABELS}),
            });
            const initialIndex = Math.max(0, ICON_CHOICES.indexOf(initialIcon));
            iconRow.set_selected(initialIndex);
            iconRow.connect('notify::selected', () => {
                applyIconPreview(ICON_CHOICES[iconRow.get_selected()] ?? '');
                saveProviders();
            });
            row.add_row(iconRow);
            const getIcon = () => ICON_CHOICES[iconRow.get_selected()] ?? '';

            // Poll every (seconds; 0 = use global).
            const pollSpin = new Adw.SpinRow({
                title: _('Poll every (seconds)'),
                subtitle: _('0 = use the global refresh interval'),
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 86400,
                    step_increment: 5,
                    value: stored?.pollSeconds ?? 0,
                }),
            });
            pollSpin.connect('notify::value', saveProviders);
            row.add_row(pollSpin);

            // Warn at.
            const warnSpin = new Adw.SpinRow({
                title: _('Warn at (%)'),
                adjustment: new Gtk.Adjustment({
                    lower: 1,
                    upper: 100,
                    step_increment: 1,
                    value: stored?.warnPct ?? DEFAULT_WARN_PCT,
                }),
            });
            warnSpin.connect('notify::value', saveProviders);
            row.add_row(warnSpin);

            // Critical at.
            const criticalSpin = new Adw.SpinRow({
                title: _('Critical at (%)'),
                adjustment: new Gtk.Adjustment({
                    lower: 1,
                    upper: 100,
                    step_increment: 1,
                    value: stored?.criticalPct ?? DEFAULT_CRITICAL_PCT,
                }),
            });
            criticalSpin.connect('notify::value', saveProviders);
            row.add_row(criticalSpin);

            // Notify on critical.
            const notifySwitch = new Adw.SwitchRow({
                title: _('Notify on critical'),
                active: stored?.notify !== false,
            });
            notifySwitch.connect('notify::active', saveProviders);
            row.add_row(notifySwitch);

            row.connect('notify::enable-expansion', () => {
                row.expanded = row.enable_expansion;
                saveProviders();
            });

            return {
                id: info.id,
                row,
                nameEntry,
                commandEntry,
                getIcon,
                pollSpin,
                warnSpin,
                criticalSpin,
                notifySwitch,
            };
        };

        // Providers stored in settings (all user-added; no built-in presets).
        for (const p of active) {
            const refs = makeCard(
                {id: p.id, name: p.name, defaultCommand: p.command ?? '', icon: p.icon},
                p,
            );
            rows.push(refs);
            group.add(refs.row);
        }

        // Add a provider.
        const addRow = new Adw.ActionRow({
            title: _('Add provider'),
            subtitle: _('Name + a codexbar CLI command'),
        });
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addBtn.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                heading: _('New provider'),
                body: _('Enter the details for your custom AI provider.'),
                transient_for: window,
                modal: true,
            });
            const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
            const nameEntry = new Gtk.Entry({placeholder_text: _('Provider name')});
            const cmdEntry = new Gtk.Entry({placeholder_text: _('Command (e.g. codexbar --provider …)')});
            content.append(nameEntry);
            content.append(cmdEntry);
            dialog.set_extra_child(content);
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('add', _('Add'));
            dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
            dialog.connect('response', (_d, response) => {
                if (response !== 'add')
                    return;
                const name = nameEntry.get_text().trim();
                const cmd = cmdEntry.get_text().trim();
                if (!name || !cmd)
                    return;
                const info: ProviderSeed = {
                    id: `custom-${Date.now()}`,
                    name,
                    defaultCommand: cmd,
                };
                const refs = makeCard(info, {id: info.id, name, command: cmd});
                rows.push(refs);
                group.add(refs.row);
                saveProviders();
            });
            dialog.present();
        });
        addRow.add_suffix(addBtn);
        group.add(addRow);

        return group;
    }

    private _buildMaintenanceGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: _('Maintenance')});
        const row = new Adw.ActionRow({
            title: _('Reset first-run state'),
            subtitle: _('Show the welcome hints again'),
        });
        const btn = new Gtk.Button({
            icon_name: 'help-about-symbolic',
            valign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', () => settings.set_boolean('first-run', true));
        row.add_suffix(btn);
        group.add(row);
        return group;
    }

    private _buildAboutGroup(): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: _('About')});

        const mk = (title: string, subtitle: string, uri: string) => {
            const row = new Adw.ActionRow({title, subtitle});
            const btn = new Gtk.Button({
                icon_name: 'adw-external-link-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            btn.connect('clicked', () => Gio.app_info_launch_default_for_uri(uri, null));
            row.add_suffix(btn);
            row.set_activatable_widget(btn);
            group.add(row);
        };

        mk(_('Website'), _('Project home and setup help'), 'https://nothingfancy.ai');

        return group;
    }
}

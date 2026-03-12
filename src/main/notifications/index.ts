// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {app, shell, Notification, ipcMain} from 'electron';
import isDev from 'electron-is-dev';
import http from 'http';
import url from 'url';
import {session} from 'electron';

import {PLAY_SOUND, NOTIFICATION_CLICKED, BROWSER_HISTORY_PUSH, OPEN_NOTIFICATION_PREFERENCES} from 'common/communication';
import Config from 'common/config';
import {Logger} from 'common/log';
import DeveloperMode from 'main/developerMode';

import getLinuxDoNotDisturb from './dnd-linux';
import getWindowsDoNotDisturb from './dnd-windows';
import {DownloadNotification} from './Download';
import {Mention} from './Mention';
import {NewVersionNotification, UpgradeNotification} from './Upgrade';

import PermissionsManager from '../permissionsManager';
import ViewManager from '../views/viewManager';
import MainWindow from '../windows/mainWindow';

const log = new Logger('Notifications');

// HTTP 请求配置
const LOCAL_HTTP_CONFIG = {
    enabled: true, // 是否启用本地 HTTP 请求
    host: 'localhost',
    port: 5000,
    path: '/debug',
    timeout: 5000, // 5 秒超时
};

class NotificationManager {
    private mentionsPerChannel?: Map<string, Mention>;
    private allActiveNotifications?: Map<string, Notification>;
    private upgradeNotification?: NewVersionNotification;
    private restartToUpgradeNotification?: UpgradeNotification;

    constructor() {
        ipcMain.on(OPEN_NOTIFICATION_PREFERENCES, this.openNotificationPreferences);

        DeveloperMode.switchOff('disableNotificationStorage', () => {
            this.mentionsPerChannel = new Map();
            this.allActiveNotifications = new Map();
        }, () => {
            this.mentionsPerChannel?.clear();
            delete this.mentionsPerChannel;
            this.allActiveNotifications?.clear();
            delete this.allActiveNotifications;
        });
    }

    /**
     * 从URL解析消息相关信息
     */
    private parseMessageInfoFromUrl(messageUrl: string): {postId?: string; channelId?: string; teamId?: string} {
        try {
            const parsedUrl = new url.URL(messageUrl);
            const pathname = parsedUrl.pathname;
            
            // Mattermost URL 格式通常是: /team/channel/post_id 或 /team/channel
            const pathParts = pathname.split('/').filter(part => part.length > 0);
            
            if (pathParts.length >= 3) {
                const teamId = pathParts[0];
                const channelId = pathParts[1];
                const postId = pathParts[2] || undefined;
                
                return {postId, channelId, teamId};
            }
        } catch (error) {
            log.warn('Failed to parse message URL', {url: messageUrl, error: (error as Error).message});
        }
        
        return {};
    }

    /**
     * 获取Mattermost API认证token
     */
    private async getMattermostAuthToken(serverUrl: URL): Promise<string | null> {
        try {
            const cookies = await session.defaultSession.cookies.get({});
            if (!cookies) {
                log.warn('No cookies found when trying to get auth token');
                return null;
            }

            // 过滤出与服务器域名匹配的cookies
            const filteredCookies = cookies.filter((cookie) => 
                cookie.domain && serverUrl.toString().includes(cookie.domain)
            );

            const authTokenCookie = filteredCookies.find((cookie) => 
                cookie.name === 'MMAUTHTOKEN'
            );

            if (!authTokenCookie) {
                log.warn('MMAUTHTOKEN cookie not found for server', {serverUrl: serverUrl.toString()});
                return null;
            }

            return authTokenCookie.value;
        } catch (error) {
            log.error('Failed to get Mattermost auth token', {error: (error as Error).message, serverUrl: serverUrl.toString()});
            return null;
        }
    }

    /**
     * 发送消息到本地 HTTP 服务
     */
    private async sendToLocalHttpService(title: string, body: string, channelId: string, teamId: string, url: string, serverName: string, serverUrl: URL): Promise<void> {
        if (!LOCAL_HTTP_CONFIG.enabled) {
            return;
        }

        // 尝试从URL解析更多信息
        const urlInfo = this.parseMessageInfoFromUrl(url);
        
        // 获取API token
        const apiToken = await this.getMattermostAuthToken(serverUrl);
        
        const payload = {
            sender: serverName,
            content: body,
            title: title,
            channelId: channelId,
            teamId: teamId,
            url: url,
            timestamp: Date.now(), // 改为毫秒时间戳格式
            // 从URL解析的额外信息
            postId: urlInfo.postId,
            parsedChannelId: urlInfo.channelId,
            parsedTeamId: urlInfo.teamId,
            // API认证信息
            apiToken: apiToken,
            serverUrl: serverUrl.toString(),
            // 标记这是截断的内容
            isTruncated: true,
            originalBodyLength: body.length,
        };

        try {
            const postData = JSON.stringify(payload);
            
            await new Promise<void>((resolve, reject) => {
                const options = {
                    hostname: LOCAL_HTTP_CONFIG.host,
                    port: LOCAL_HTTP_CONFIG.port,
                    path: LOCAL_HTTP_CONFIG.path,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                    },
                    timeout: LOCAL_HTTP_CONFIG.timeout,
                };

                const req = http.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        log.debug('Successfully sent message to local HTTP service', {statusCode: res.statusCode, serverName});
                        resolve();
                    });
                });

                req.on('error', (error) => {
                    log.warn('Failed to send message to local HTTP service', {error: error.message, serverName});
                    resolve(); // 不阻塞主流程，即使HTTP请求失败
                });

                req.on('timeout', () => {
                    log.warn('Timeout when sending message to local HTTP service', {serverName});
                    req.destroy();
                    resolve(); // 不阻塞主流程
                });

                req.write(postData);
                req.end();
            });
        } catch (error) {
            log.warn('Exception when sending message to local HTTP service', {error: (error as Error).message, serverName});
        }
    }

    public async displayMention(title: string, body: string, channelId: string, teamId: string, url: string, silent: boolean, webcontents: Electron.WebContents, soundName: string) {
        log.debug('displayMention', {channelId, teamId, url, silent, soundName});

        if (!Notification.isSupported()) {
            log.error('notification not supported');
            return {status: 'error', reason: 'notification_api', data: 'notification not supported'};
        }

        if (await getDoNotDisturb()) {
            log.debug('do not disturb is on, will not send');
            return {status: 'not_sent', reason: 'os_dnd'};
        }

        const view = ViewManager.getViewByWebContentsId(webcontents.id);
        if (!view) {
            log.error('missing view', webcontents.id);
            return {status: 'error', reason: 'missing_view'};
        }
        const serverName = view.view.server.name;
        const serverUrl = view.view.server.url;
        if (!view.view.shouldNotify) {
            log.debug('should not notify for this view', webcontents.id);
            return {status: 'not_sent', reason: 'view_should_not_notify'};
        }

        const options = {
            title: `${serverName}: ${title}`,
            body,
            silent,
            soundName,
        };

        if (!await PermissionsManager.doPermissionRequest(webcontents.id, 'notifications', {requestingUrl: view.view.server.url.toString(), isMainFrame: false})) {
            log.verbose('permissions disallowed', webcontents.id, serverName, view.view.server.url.toString());
            return {status: 'not_sent', reason: 'notifications_permission_disallowed'};
        }

        const mention = new Mention(options, channelId, teamId);
        this.allActiveNotifications?.set(mention.uId, mention);

        mention.on('click', () => {
            log.debug('notification click', serverName, mention.uId);

            this.allActiveNotifications?.delete(mention.uId);

            // Show the window after navigation has finished to avoid the focus handler
            // being called before the current channel has updated
            const focus = () => {
                MainWindow.show();
                ViewManager.showById(view.id);
                ipcMain.off(BROWSER_HISTORY_PUSH, focus);
            };
            ipcMain.on(BROWSER_HISTORY_PUSH, focus);
            webcontents.send(NOTIFICATION_CLICKED, channelId, teamId, url);
        });

        mention.on('close', () => {
            this.allActiveNotifications?.delete(mention.uId);
        });

        return new Promise((resolve) => {
            // If mention never shows somehow, resolve the promise after 10s
            const timeout = setTimeout(() => {
                log.debug('notification timeout', serverName, mention.uId);
                resolve({status: 'error', reason: 'notification_timeout'});
            }, 10000);
            let failed = false;

            mention.on('show', () => {
                // Ensure the failed event isn't also called, if it is we should resolve using its method
                setTimeout(() => {
                    if (!failed) {
                        log.debug('displayMention.show', serverName, mention.uId);

                        // On Windows, manually dismiss notifications from the same channel and only show the latest one
                        if (process.platform === 'win32') {
                            const mentionKey = `${mention.teamId}:${mention.channelId}`;
                            if (this.mentionsPerChannel?.has(mentionKey)) {
                                log.debug(`close ${mentionKey}`);
                                this.mentionsPerChannel?.get(mentionKey)?.close();
                                this.mentionsPerChannel?.delete(mentionKey);
                            }
                            this.mentionsPerChannel?.set(mentionKey, mention);
                        }
                        const notificationSound = mention.getNotificationSound();
                        if (notificationSound) {
                            MainWindow.sendToRenderer(PLAY_SOUND, notificationSound);
                        }
                        
                        // 调用本地 HTTP 服务发送消息内容，包含服务器URL
                        this.sendToLocalHttpService(title, body, channelId, teamId, url, serverName, serverUrl);
                        
                        flashFrame(true);
                        clearTimeout(timeout);
                        resolve({status: 'success'});
                    }
                }, 0);
            });

            mention.on('failed', (_, error) => {
                failed = true;
                this.allActiveNotifications?.delete(mention.uId);
                clearTimeout(timeout);

                // Special case for Windows - means that notifications are disabled at the OS level
                if (error.includes('HRESULT:-2143420143')) {
                    log.warn('notifications disabled in Windows settings');
                    resolve({status: 'not_sent', reason: 'windows_permissions_denied'});
                } else {
                    log.error('notification failed to show', serverName, mention.uId, error);
                    resolve({status: 'error', reason: 'electron_notification_failed', data: error});
                }
            });
            mention.show();
        });
    }

    public async displayDownloadCompleted(fileName: string, path: string, serverName: string) {
        log.debug('displayDownloadCompleted', {fileName, path, serverName});

        if (!Notification.isSupported()) {
            log.error('notification not supported');
            return;
        }

        if (await getDoNotDisturb()) {
            return;
        }

        const download = new DownloadNotification(fileName, serverName);
        this.allActiveNotifications?.set(download.uId, download);

        download.on('show', () => {
            flashFrame(true);
        });

        download.on('click', () => {
            shell.showItemInFolder(path.normalize());
            this.allActiveNotifications?.delete(download.uId);
        });

        download.on('close', () => {
            this.allActiveNotifications?.delete(download.uId);
        });

        download.on('failed', () => {
            this.allActiveNotifications?.delete(download.uId);
        });
        download.show();
    }

    public async displayUpgrade(version: string, handleUpgrade: () => void) {
        if (!Notification.isSupported()) {
            log.error('notification not supported');
            return;
        }
        if (await getDoNotDisturb()) {
            return;
        }

        if (this.upgradeNotification) {
            this.upgradeNotification.close();
        }
        this.upgradeNotification = new NewVersionNotification();
        this.upgradeNotification.on('click', () => {
            log.info(`User clicked to upgrade to ${version}`);
            handleUpgrade();
        });
        this.upgradeNotification.show();
    }

    public async displayRestartToUpgrade(version: string, handleUpgrade: () => void) {
        if (!Notification.isSupported()) {
            log.error('notification not supported');
            return;
        }
        if (await getDoNotDisturb()) {
            return;
        }

        this.restartToUpgradeNotification = new UpgradeNotification();
        this.restartToUpgradeNotification.on('click', () => {
            log.info(`User requested perform the upgrade now to ${version}`);
            handleUpgrade();
        });
        this.restartToUpgradeNotification.show();
    }

    private openNotificationPreferences() {
        switch (process.platform) {
        case 'darwin':
            shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications?Notifications');
            break;
        case 'win32':
            shell.openExternal('ms-settings:notifications');
            break;
        }
    }
}

export async function getDoNotDisturb() {
    if (process.platform === 'win32') {
        return getWindowsDoNotDisturb();
    }

    if (process.platform === 'linux') {
        return getLinuxDoNotDisturb();
    }

    return false;
}

function flashFrame(flash: boolean) {
    if (process.platform === 'linux' || process.platform === 'win32') {
        if (Config.notifications.flashWindow) {
            MainWindow.get()?.flashFrame(flash);
        }
    }
    if (process.platform === 'darwin' && Config.notifications.bounceIcon) {
        app.dock.bounce(Config.notifications.bounceIconType);
    }
}

const notificationManager = new NotificationManager();
export default notificationManager;
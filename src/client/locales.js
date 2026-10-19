/**
 * Plugin copy, in both shipped locales.
 *
 * The dictionary is registered through the Client locale service, so text
 * follows the user's active locale without re-registering.
 *
 * @module dsh-file-extension/client/locales
 */

/** Locale namespace this plugin owns. */
export const NS = 'dshFileExtension'

/** English copy. */
export const en = {
  'menu.reveal': 'Reveal in File Manager',
  'menu.reveal.disabled': 'This host cannot open a system file manager',
  'menu.addToChat': 'Add to Conversation',
  'menu.addToChat.disabled': 'No conversation is open for this file',
  'menu.openInTab': 'Open in New Tab',
  'menu.saveAs': 'Save As…',
  'menu.copyPath': 'Copy Path',
  'menu.copyAbsolutePath': 'Copy Absolute Path',
  'menu.copyRelativePath': 'Copy Relative Path',
  'menu.rename': 'Rename',
  'menu.delete': 'Delete',
  'menu.deleteDirectory': 'Delete Folder',

  'toast.pathCopied': 'Path copied',
  'toast.addedToChat': 'Added to the conversation',
  'toast.addedToChatFailed': 'The draft changed while inserting; please retry',
  'toast.renameSuccess': 'Renamed to “{name}”',
  'toast.deleteTrashed': 'Moved to the recycle bin',
  'toast.deletePermanent': 'Deleted permanently',
  'toast.savedAs': 'Saved a copy to {path}',
  'toast.saveAsFailed': 'Save as failed: {message}',
  'toast.openFailed': 'Could not open the file',
  'toast.revealFailed': 'Could not reveal the file',
  'toast.copyFailed': 'Could not copy to the clipboard',
  'toast.unavailable': 'Not available on this host: {message}',

  'dialog.delete.title': 'Delete “{name}”?',
  'dialog.delete.body': 'The file will be moved to the recycle bin and can be restored from there.',
  'dialog.delete.bodyDirectory': 'The folder and everything inside it will be moved to the recycle bin and can be restored from there.',
  'dialog.delete.bodyPermanent': 'This action permanently deletes the file and cannot be undone.',
  'dialog.delete.bodyPermanentDirectory': 'This action permanently deletes the folder and everything inside it, and cannot be undone.',
  'dialog.delete.confirm': 'Delete',
  'dialog.delete.confirmPermanent': 'Delete Permanently',

  'dialog.rename.title': 'Rename',
  'dialog.rename.label': 'New name',
  'dialog.rename.confirm': 'Rename',

  'dialog.saveAs.title': 'Save a Copy',
  'dialog.saveAs.name': 'File name',
  'dialog.saveAs.directory': 'Destination folder',
  'dialog.saveAs.choose': 'Choose…',
  'dialog.saveAs.confirm': 'Save',
  'dialog.saveAs.download': 'Download',
  'dialog.saveAs.overwrite': '“{name}” already exists in that folder. Replace it?',
  'dialog.saveAs.tooLarge': 'The file is {size}; it may take a while to download.',
  'dialog.saveAs.downloadHint': 'This host cannot write to disk from the browser, so the file is downloaded instead.',

  'dialog.cancel': 'Cancel',

  'error.empty': 'The name cannot be empty',
  'error.invalidCharacters': 'The name contains characters that are not allowed',
  'error.tooLong': 'The name is too long',
  'error.trailingDotOrSpace': 'The name cannot end with a dot or a space',
  'error.reservedName': 'That name is reserved by the operating system',
  'error.alreadyExists': 'An entry with that name already exists',
  'error.permission': 'Permission denied by the operating system',
  'error.notFound': 'The file no longer exists',
  'error.notRegularFile': 'Only regular files support this action',
  'error.notDirectory': 'The destination is not a folder',
  'error.outsideWorkspace': 'The path is outside this session’s workspace',
  'error.tooLarge': 'The file is too large',
  'error.unsupported': 'Not supported on this host',
  'error.operationFailed': 'The operation failed: {message}',

  'aria.atButton': 'Add to conversation',
  'aria.menu': 'File actions',
}

/** Simplified Chinese copy. */
export const zh = {
  'menu.reveal': '在文件资源管理器中显示',
  'menu.reveal.disabled': '当前宿主无法打开系统文件管理器',
  'menu.addToChat': '添加到对话',
  'menu.addToChat.disabled': '当前没有可用的会话',
  'menu.openInTab': '在新标签页中打开',
  'menu.saveAs': '另存为…',
  'menu.copyPath': '复制路径',
  'menu.copyAbsolutePath': '复制绝对路径',
  'menu.copyRelativePath': '复制相对路径',
  'menu.rename': '重命名',
  'menu.delete': '删除',
  'menu.deleteDirectory': '删除文件夹',

  'toast.pathCopied': '路径已复制',
  'toast.addedToChat': '已添加到对话',
  'toast.addedToChatFailed': '插入时草稿已变化，请重试',
  'toast.renameSuccess': '已重命名为「{name}」',
  'toast.deleteTrashed': '已移动到回收站',
  'toast.deletePermanent': '已永久删除',
  'toast.savedAs': '副本已保存到 {path}',
  'toast.saveAsFailed': '另存为失败：{message}',
  'toast.openFailed': '无法打开该文件',
  'toast.revealFailed': '无法在文件管理器中显示',
  'toast.copyFailed': '无法复制到剪贴板',
  'toast.unavailable': '当前宿主不支持：{message}',

  'dialog.delete.title': '删除「{name}」？',
  'dialog.delete.body': '该文件将被移动到回收站，可以从回收站恢复。',
  'dialog.delete.bodyDirectory': '该文件夹及其全部内容将被移动到回收站，可以从回收站恢复。',
  'dialog.delete.bodyPermanent': '该操作将永久删除，不可恢复。',
  'dialog.delete.bodyPermanentDirectory': '该操作将永久删除该文件夹及其全部内容，不可恢复。',
  'dialog.delete.confirm': '删除',
  'dialog.delete.confirmPermanent': '永久删除',

  'dialog.rename.title': '重命名',
  'dialog.rename.label': '新名称',
  'dialog.rename.confirm': '重命名',

  'dialog.saveAs.title': '另存为副本',
  'dialog.saveAs.name': '文件名',
  'dialog.saveAs.directory': '目标文件夹',
  'dialog.saveAs.choose': '选择…',
  'dialog.saveAs.confirm': '保存',
  'dialog.saveAs.download': '下载',
  'dialog.saveAs.overwrite': '该文件夹中已存在「{name}」，是否覆盖？',
  'dialog.saveAs.tooLarge': '文件大小为 {size}，下载可能需要一些时间。',
  'dialog.saveAs.downloadHint': '当前宿主无法从浏览器写盘，将改为浏览器下载。',

  'dialog.cancel': '取消',

  'error.empty': '名称不能为空',
  'error.invalidCharacters': '名称包含不允许的字符',
  'error.tooLong': '名称过长',
  'error.trailingDotOrSpace': '名称不能以点或空格结尾',
  'error.reservedName': '该名称被操作系统保留',
  'error.alreadyExists': '已存在同名文件',
  'error.permission': '操作系统拒绝了该操作（权限不足）',
  'error.notFound': '文件已不存在',
  'error.notRegularFile': '仅普通文件支持该操作',
  'error.notDirectory': '目标不是文件夹',
  'error.outsideWorkspace': '路径超出了当前会话的工作区',
  'error.tooLarge': '文件过大',
  'error.unsupported': '当前宿主不支持该操作',
  'error.operationFailed': '操作失败：{message}',

  'aria.atButton': '添加到对话',
  'aria.menu': '文件操作',
}

const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'io.dsh.desktop.dev',
  productName: '北斗work',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'dsh-desktop-dev',
    productName: '北斗work',
    dshDesktopChannel: 'development'
  },
  artifactName: 'beidou-work-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'beidou-work-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}

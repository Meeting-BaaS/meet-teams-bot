# Changelog

All notable changes to Meet Teams Bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- V8 heap cap for large meetings (`--max-old-space-size=4096`) was passed as a
  bare Chromium argument and silently ignored; now passed via `--js-flags`.

### Added
- Initial open source release
- Comprehensive documentation and README
- Contributing guidelines
- Security policy
- Docker support for easy deployment

### Changed
- Live capture encode switched from x264 preset `fast` to `veryfast`: ~40% less
  encoder CPU per bot at the same crf 23, near-identical quality on meeting
  content, output ~10-15% larger.
- Translated all French comments to English
- Updated project metadata for open source
- Improved code organization and structure

### Security
- Added security policy and vulnerability reporting process
- Enhanced .gitignore to prevent sensitive data exposure

## [1.0.0] - 2024-01-XX

### Added
- Multi-platform meeting recording support (Google Meet, Microsoft Teams, Zoom)
- Automated bot joining and recording capabilities
- Real-time speaker detection and switching
- Speech-to-text transcription support
- Custom branding and bot naming
- State machine for reliable bot lifecycle management
- Chrome extension for enhanced browser integration
- S3 integration for automatic file uploads
- Webhook notifications for status updates
- Serverless mode for containerized deployments
- Comprehensive logging and monitoring
- FFmpeg integration for media processing
- Redis and RabbitMQ support for queue management

### Features
- **Browser Automation**: Playwright-based automation for web meetings
- **Recording Modes**: Support for speaker view and other recording formats
- **Error Handling**: Robust error recovery and state management
- **Scalability**: Designed for production deployment
- **Extensibility**: Modular architecture for adding new platforms

### Technical Details
- TypeScript 5.4+ with strict type checking
- Node.js 14.16+ compatibility
- Docker containerization support
- Comprehensive test suite with Jest
- ESLint and Prettier for code quality
- Winston for structured logging

---

## Release Notes

### Version 1.0.0

This is the initial open source release of Meet Teams Bot. The project has been thoroughly prepared for community contribution with:

- Complete English documentation
- Secure handling of sensitive data
- Comprehensive development guidelines
- Production-ready Docker configuration
- Extensive testing framework

### Breaking Changes

None for initial release.

### Migration Guide

This is the first public release, so no migration is required.

### Known Issues

- Chrome extension requires manual installation for development
- Some meeting platforms may require specific browser configurations
- Zoom integration requires additional SDK setup on Linux

### Upcoming Features

- Enhanced speaker recognition algorithms
- Additional meeting platform support
- Improved audio quality processing
- Real-time collaboration features
- Advanced analytics and reporting

---

## Support

For questions about releases or changes:
- Check the [Issues](https://github.com/yourusername/meet-teams-bot/issues) page
- Read the [Documentation](README.md)
- Review [Contributing Guidelines](CONTRIBUTING.md)

## Contributors

Thanks to all contributors who made this release possible. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the full list. 
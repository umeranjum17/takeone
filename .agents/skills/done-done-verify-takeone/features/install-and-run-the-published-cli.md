# Install and run the published CLI

This is a package-boundary journey. On the exact candidate checkout, run `npm pack`, install its tarball into an empty prefix, then invoke both `takeone --version` and `takeone-axi --version`; both must equal `package.json`'s version. Run `takeone doctor` from that prefix and confirm it resolves bundled `dist/` and installed runtime dependencies without a build at install time. Keep the package file list and command output as evidence.

package gate

import "strings"

// IdentityOf derives the environment-independent application identity from an
// Argo CD Application name.
//
// The convention is "<env>-<identity>", where env is the Application's
// spec.project. A name without that prefix is returned unchanged, so an app
// named after its own project still gets a usable identity.
func IdentityOf(name, project string) string {
	return strings.TrimPrefix(name, project+"-")
}

// AppNameFor composes the Application name for an identity in an environment.
func AppNameFor(env, identity string) string {
	return env + "-" + identity
}

export function toCurrentUser(user) {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
    };
}
//# sourceMappingURL=currentUser.js.map
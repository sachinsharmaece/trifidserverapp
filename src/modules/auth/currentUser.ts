import type { Role } from '../../shared/enums.js';

/** What the API tells the browser about the signed-in person. Never includes the password hash. */
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** true while the person is still on a temporary password: they must choose their own first. */
  mustChangePassword: boolean;
}

export function toCurrentUser(user: CurrentUser): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

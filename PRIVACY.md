# Privacy

Carry is designed to sync directly between devices without an account,
analytics, advertising, or hosted file storage.

## Data kept on your devices

Carry stores device identity, pairing details, sync baselines, checkpoints,
temporary transfer data, and activity records under `.carry` inside the selected
project. Shared agent memory may be stored under `.shared-memory`. Both paths are
ignored by this repository, and Carry protects a project's `.carry` directory
from accidental Git inclusion when it initializes the folder.

Pairing records contain credentials. Do not publish, email, or commit `.carry`,
invitation URLs, diagnostic logs, or screenshots that expose a complete code.
Forgetting a device removes its local trust record; remove the peer on every
device that should no longer trust it and create a fresh invitation.

## Data visible on the network

Project content, device/project names, control messages, and transfer frames are
encrypted and authenticated before relay transport. A relay operator or network
provider can still observe connection metadata such as IP addresses, timing,
opaque room identifiers, and traffic volume. Experimental direct connections
also reveal ordinary network addressing metadata to the paired device and STUN
provider.

LAN discovery announces enough local-network information for another Carry
device to find the pairing service. Only use LAN pairing on a network you trust.

The checked-in relay implementation forwards ciphertext and is not intended to
store project files. Anyone running a relay is nevertheless responsible for its
infrastructure logs, retention policy, access controls, and applicable law. A
public deployment should publish its own operator and retention information.

## Removing local data

Use **Forget device** to remove a saved pairing. Checkpoints can be deleted from
Carry's recovery interface. To remove all Carry metadata from a project, first
disconnect it from every paired device and close Carry, then delete that
project's `.carry` directory. This does not delete the project files themselves.

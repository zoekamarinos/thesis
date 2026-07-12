import numpy as np


SIZE_U = 5
SIZE_V = 7


def cube_sphere_patch(face):

    u = np.linspace(-1, 1, SIZE_U)
    v = np.linspace(-1, 1, SIZE_V)

    points = []

    for i in u:
        for j in v:

            if face == "+X":
                x, y, z = 1, i, j

            elif face == "-X":
                x, y, z = -1, i, j

            elif face == "+Y":
                x, y, z = i, 1, j

            elif face == "-Y":
                x, y, z = i, -1, j

            elif face == "+Z":
                x, y, z = i, j, 1

            elif face == "-Z":
                x, y, z = i, j, -1


            # Project cube face onto sphere

            r = np.sqrt(
                x*x +
                y*y +
                z*z
            )

            points.append(
                (
                    x/r,
                    y/r,
                    z/r
                )
            )

    return points



faces = [
    "+X",
    "-X",
    "+Y",
    "-Y",
    "+Z",
    "-Z"
]


with open("sphere.txt", "w") as file:

    for index, face in enumerate(faces):

        file.write("# PATCH\n")

        patch = cube_sphere_patch(face)

        for x, y, z in patch:

            file.write(
                f"{x},{y},{z}\n"
            )


        # blank line between patches
        file.write("\n")


print("Created sphere.txt")
print("Patches:", len(faces))
print("Points per patch:", SIZE_U * SIZE_V)
print("Total points:", len(faces) * SIZE_U * SIZE_V)